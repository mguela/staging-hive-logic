// Controlled, short-recording replacement for browser SpeechRecognition.
// It records only after the user starts Voice, sends one bounded clip to the
// authenticated Reina transcription endpoint, and stops all tracks immediately.

function stopTracks(stream) {
  try { for (const track of stream?.getTracks?.() || []) track?.stop?.(); } catch (_) {}
}

function errorCode(error) {
  const name = error && typeof error.name === 'string' ? error.name : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'not-allowed';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'no-microphone';
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'device-busy';
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') return 'device-not-found';
  return 'unavailable';
}

function pickMimeType(Recorder) {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const type of candidates) {
    try {
      if (typeof Recorder?.isTypeSupported === 'function' && Recorder.isTypeSupported(type)) return type;
    } catch (_) {}
  }
  return '';
}

export function createControlledTranscriptionRecognitionFactory(options = {}) {
  const windowRef = options.windowRef && typeof options.windowRef === 'object' ? options.windowRef : null;
  let openMicrophone = typeof options.openMicrophone === 'function' ? options.openMicrophone : null;
  const transcribeAudio = typeof options.transcribeAudio === 'function' ? options.transcribeAudio : null;
  let Recorder = typeof options.MediaRecorder === 'function' ? options.MediaRecorder : null;
  const getAudioConstraints = typeof options.getAudioConstraints === 'function'
    ? options.getAudioConstraints : () => ({ audio: true });
  if (!openMicrophone && windowRef) {
    try {
      const devices = windowRef.navigator?.mediaDevices;
      if (typeof devices?.getUserMedia === 'function') {
        openMicrophone = (constraints) => devices.getUserMedia(constraints || { audio: true });
      }
    } catch (_) {}
  }
  if (!Recorder && windowRef && typeof windowRef.MediaRecorder === 'function') Recorder = windowRef.MediaRecorder;
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
  const setPoll = typeof options.setInterval === 'function' ? options.setInterval : setInterval;
  const clearPoll = typeof options.clearInterval === 'function' ? options.clearInterval : clearInterval;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const AudioContextCtor = typeof options.AudioContext === 'function'
    ? options.AudioContext
    : (windowRef?.AudioContext || windowRef?.webkitAudioContext || null);
  const maximumMs = Number.isSafeInteger(options.maximumMs) ? Math.min(Math.max(options.maximumMs, 1_000), 15_000) : 15_000;
  // Keep a natural sentence pause, but hand completed speech to transcription
  // promptly. The former 1.2s tail was noticeable before either transcription
  // or Reina's answer could even begin.
  const silenceMs = Number.isSafeInteger(options.silenceMs) ? Math.min(Math.max(options.silenceMs, 350), 3_000) : 900;
  const initialSilenceMs = Number.isSafeInteger(options.initialSilenceMs) ? Math.min(Math.max(options.initialSilenceMs, 1_000), 8_000) : 6_000;
  const activityThreshold = Number.isSafeInteger(options.activityThreshold) ? Math.min(Math.max(options.activityThreshold, 2), 60) : 4;
  // The loudest sample a recording must reach before it is worth transcribing.
  // Measured on real failures: a clip peaking at 5 of 127 -- roughly 4% of
  // full scale, the noise floor -- cleared an activity threshold of 4 by one
  // point, armed the recorder, and was sent to transcription, which answered
  // with an empty string. That is not "no words were said"; it is a
  // microphone that is not picking the speaker up, and the two need different
  // words to the user.
  //
  // The floor was 12, set from that one clip, and it was too low. Every
  // measured attempt since -- peaks of 1, 5, 14 and 17, across four different
  // inputs -- produced an empty transcript, and the two that cleared 12 were
  // told the transcription service was at fault when the recording had in
  // fact peaked at 13% of full scale.
  //
  // 18 is fitted to the evidence from both sides rather than picked: strictly
  // above 17, the loudest peak that has ever failed, and strictly below 20,
  // which this file's own tests already require to be treated as quiet-but-
  // real speech and transcribed. Anything in between is unmeasured, so the
  // narrowest defensible band is the honest choice.
  const audibleFloor = Number.isSafeInteger(options.audibleFloor) ? Math.min(Math.max(options.audibleFloor, 0), 64) : 18;
  // The other end of the same problem, and until now it had no name. The meter
  // reports Math.abs(sample - 128) over a Uint8 buffer, so 128 is the rail: a
  // signal reaching it is not "loud", it is clipped, and the waveform above the
  // ceiling has been flattened away. Transcription returns an empty string for
  // that just as readily as it does for silence, so a user whose input is
  // distorting was told the same unhelpful thing as one whose microphone was
  // not picking them up at all. Measured on a real turn: peak 128 of 128,
  // 58 KB over 5.5 seconds, empty transcript.
  const clippingCeiling = Number.isSafeInteger(options.clippingCeiling) ? Math.min(Math.max(options.clippingCeiling, 64), 128) : 126;
  // One sample touching the rail is a transient, not a defect. Sustained
  // railing is. Each poll is a 512-sample window, so this is the number of
  // separate windows that must come back railed before the input is called
  // distorted rather than merely loud.
  const clippedPollsAllowed = Number.isSafeInteger(options.clippedPollsAllowed) ? Math.min(Math.max(options.clippedPollsAllowed, 0), 100) : 2;
  // How long a transcription attempt may take before the recording is declared
  // unanswered. Generous -- this is a backstop against silence, not a latency
  // budget -- but finite, which is the point.
  const transcriptionMs = Number.isSafeInteger(options.transcriptionMs) ? Math.min(Math.max(options.transcriptionMs, 2_000), 60_000) : 20_000;
  // How long opening the microphone may take before the attempt is abandoned.
  // getUserMedia is not guaranteed to settle: a permission prompt the user
  // never answers, a device another application is mid-grab of, or a
  // Chromium audio backend that has wedged all leave the promise pending
  // forever. Nothing downstream of it was armed yet -- no maximum timer, no
  // silence poll -- so a pending open left the panel waiting with no error,
  // no console line and no diagnostic. Every other stage is bounded; this
  // one was the hole.
  const startupMs = Number.isSafeInteger(options.startupMs) ? Math.min(Math.max(options.startupMs, 2_000), 30_000) : 10_000;
  // How long after MediaRecorder.stop() the 'stop' event may take to arrive.
  // requestStop() clears the maximum timer and the silence poll before
  // calling stop(), so if onstop never fires there is nothing left running:
  // stopRequested is already true, every later requestStop() returns
  // immediately, and the recording hangs with the audio it captured still in
  // hand. Deliver that audio on a deadline instead of waiting for an event
  // that is not coming.
  const stopMs = Number.isSafeInteger(options.stopMs) ? Math.min(Math.max(options.stopMs, 1_000), 15_000) : 4_000;
  // Most microphone failures never reach a server, so the only record of them
  // has been a console line in front of whoever was speaking. Report the shape
  // of each one instead. Injected, optional, and wrapped: a recorder must keep
  // recording whether or not anything is listening to its diagnostics.
  const reportDiagnostic = typeof options.reportDiagnostic === 'function' ? options.reportDiagnostic : null;
  const report = (record) => {
    if (!reportDiagnostic) return;
    try { Promise.resolve(reportDiagnostic(record)).catch(() => {}); } catch (_) {}
  };
  if (!openMicrophone || !transcribeAudio || !Recorder) return null;

  return function controlledRecognition() {
    const instance = { lang: 'en-US', interimResults: false, continuous: false, onstart: null, onresult: null, onerror: null, onend: null };
    let active = false; let recorder = null; let stream = null; let timer = null; let poll = null; let chunks = []; let cancelled = false;
    let audioContext = null; let analyser = null; let source = null; let sampleBuffer = null; let startedAt = 0; let speechSeen = false; let lastSpeechAt = 0; let stopRequested = false;
    // Carried into every diagnostic: the loudest sample this recording saw, and
    // which input produced it. "It heard nothing" and "it heard you and the
    // transcript came back empty" are the same console line without them.
    let peakSeen = 0; let deviceLabel = ''; let sampled = false; let clippedPolls = 0;
    // Peak alone cannot tell speech from amplified room tone: both can pin the
    // meter. Speech is spiky -- loud syllables over near-silence between them --
    // so its average sits far below its peak. Steady noise is flat, and its
    // average sits close to its peak. Carrying the running mean square makes
    // "loud" and "intelligible" separable in a diagnostic row, which they were
    // not: every recording so far, from peak 1 to peak 128 across four
    // microphones, came back from transcription as an empty string, and peak
    // could not say which of those were quiet, which were distorted, and which
    // were simply a room being amplified.
    let squareSum = 0; let squareWindows = 0;
    // A recording is delivered to transcription exactly once, whether the
    // recorder's own 'stop' event or the stop deadline gets there first.
    let delivered = false; let startupTimer = null;
    const emit = (name, data) => { try { if (typeof instance[name] === 'function') instance[name](data); } catch (_) {} };
    const rmsSeen = () => (squareWindows ? Math.round(Math.sqrt(squareSum / squareWindows) * 10) / 10 : 0);
    const crestFactor = () => {
      const rms = rmsSeen();
      return rms > 0 ? Math.round((peakSeen / rms) * 10) / 10 : 0;
    };
    // Assigned once the recorder exists; requestStop() may reach for it first.
    let deliverRecording = () => { finish(); };
    const clearCaptureMonitoring = () => {
      if (timer !== null) clearTimer(timer); timer = null;
      if (startupTimer !== null) clearTimer(startupTimer); startupTimer = null;
      if (poll !== null) clearPoll(poll); poll = null;
      try { source?.disconnect?.(); } catch (_) {}
      try { analyser?.disconnect?.(); } catch (_) {}
      try { audioContext?.close?.(); } catch (_) {}
      source = null; analyser = null; audioContext = null; sampleBuffer = null;
    };
    const finish = () => { if (!active) return; active = false; clearCaptureMonitoring(); stopTracks(stream); stream = null; emit('onend', {}); };
    const fail = (code, extra) => {
      if (!active) return;
      report({
        stage: 'recognition',
        code: String(code),
        peak: peakSeen,
        rms: rmsSeen(),
        // peak / rms. Speech runs high -- roughly 4 and up. A steady tone or an
        // amplified empty room runs low, near 1.5. This is the number that says
        // whether a loud recording contained anything worth transcribing.
        crest: crestFactor(),
        clippedPolls,
        activityThreshold,
        speechSeen: speechSeen ? 1 : 0,
        msSinceStart: Math.max(0, Math.round(now() - startedAt)),
        deviceLabel: deviceLabel || undefined,
        ...(extra || {}),
      });
      emit('onerror', { error: code });
      finish();
    };
    const result = (text) => {
      if (!active) return;
      const alternative = Object.freeze({ transcript: text });
      const final = Object.freeze({ 0: alternative, length: 1, isFinal: true });
      emit('onresult', { resultIndex: 0, results: [final] }); finish();
    };
    const requestStop = () => {
      if (stopRequested || !active) return;
      stopRequested = true;
      clearCaptureMonitoring();
      try {
        if (recorder?.state !== 'recording') { deliverRecording('not-recording'); return; }
        recorder.stop();
        // stop() is a request, not a guarantee, so arm a backstop -- unless
        // the recorder answered synchronously and the recording is already on
        // its way, in which case there is nothing left to back up.
        if (!delivered && active) timer = setTimer(() => deliverRecording('stop-timeout'), stopMs);
      } catch (error) { fail(errorCode(error)); }
    };
    const beginSilenceDetection = () => {
      if (!AudioContextCtor || !stream || !active) return;
      try {
        audioContext = new AudioContextCtor();
        // Some Chromium builds create the analyser suspended even though the
        // microphone permission indicator is active. Resume it explicitly so
        // quiet real speech is not misclassified as initial silence.
        try {
          if (audioContext.state === 'suspended' && typeof audioContext.resume === 'function') {
            Promise.resolve(audioContext.resume()).catch(() => {});
          }
        } catch (_) {}
        source = audioContext.createMediaStreamSource(stream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        sampleBuffer = new Uint8Array(analyser.fftSize);
        poll = setPoll(() => {
          if (!active || !analyser || !sampleBuffer) return;
          try {
            analyser.getByteTimeDomainData(sampleBuffer);
            let peak = 0;
            let squares = 0;
            for (const sample of sampleBuffer) {
              const magnitude = Math.abs(sample - 128);
              if (magnitude > peak) peak = magnitude;
              squares += magnitude * magnitude;
            }
            if (peak > peakSeen) peakSeen = peak;
            if (peak >= clippingCeiling) clippedPolls += 1;
            squareSum += squares / sampleBuffer.length;
            squareWindows += 1;
            sampled = true;
            const current = now();
            if (peak >= activityThreshold) {
              if (!speechSeen) { try { console.warn('[reina-mic] speech detected', { peak, activityThreshold, msSinceStart: current - startedAt }); } catch (_) {} }
              speechSeen = true; lastSpeechAt = current; return;
            }
            if (speechSeen && current - lastSpeechAt >= silenceMs) { try { console.warn('[reina-mic] stopping: silence after speech', { silenceMs, msSinceStart: current - startedAt }); } catch (_) {} requestStop(); }
            else if (!speechSeen && current - startedAt >= initialSilenceMs) { try { console.warn('[reina-mic] stopping: no speech ever detected', { initialSilenceMs, peak, activityThreshold }); } catch (_) {} requestStop(); }
          } catch (_) { /* The bounded maximum timer remains the safe fallback. */ }
        }, 100);
      } catch (_) {
        clearCaptureMonitoring();
      }
    };
    instance.start = () => {
      if (active) throw new Error('recognition_active');
      active = true; cancelled = false; chunks = []; stopRequested = false; speechSeen = false; lastSpeechAt = 0; startedAt = now();
      peakSeen = 0; deviceLabel = ''; sampled = false; clippedPolls = 0;
      squareSum = 0; squareWindows = 0;
      delivered = false;
      startupTimer = setTimer(() => {
        if (!active) return;
        try { console.warn('[reina-mic] microphone never opened', { startupMs }); } catch (_) {}
        fail('microphone-open-timeout', { stage: 'startup', msSinceStart: startupMs });
      }, startupMs);
      const constraints = getAudioConstraints();
      const requestedDeviceId = constraints && constraints.audio && typeof constraints.audio === 'object'
        ? constraints.audio.deviceId && constraints.audio.deviceId.exact : null;
      const openWithFallback = () => Promise.resolve().then(() => openMicrophone(constraints)).catch((error) => {
        // A previously-selected input device that no longer exists (unplugged,
        // USB re-enumeration, an OS update) throws OverconstrainedError against
        // an exact deviceId constraint -- previously this failed voice outright
        // with a vague "could not start" message. Fall back to the system
        // default microphone instead, mirroring the existing output-device
        // fallback in reina-neural-speech.js: a missing device should degrade,
        // not break voice entirely.
        if (!requestedDeviceId || errorCode(error) !== 'device-not-found') throw error;
        try { console.warn('[reina-mic] selected input device unavailable, falling back to system default', { deviceId: requestedDeviceId }); } catch (_) {}
        report({ stage: 'device-fallback', code: 'device-not-found', deviceId: requestedDeviceId });
        const fallbackAudio = Object.assign({}, constraints.audio);
        delete fallbackAudio.deviceId;
        return openMicrophone(Object.assign({}, constraints, { audio: fallbackAudio }));
      });
      return openWithFallback().then((opened) => {
        if (!active) { stopTracks(opened); return false; }
        stream = opened;
        let track;
        try { track = stream?.getAudioTracks?.()[0]; } catch (_) { track = null; }
        if (!track || track.readyState !== 'live' || track.enabled === false) {
          try { console.warn('[reina-mic] track unavailable', { hasTrack: !!track, readyState: track?.readyState, enabled: track?.enabled, label: track?.label }); } catch (_) {}
          fail('unavailable'); return false;
        }
        try { deviceLabel = typeof track.label === 'string' ? track.label : ''; } catch (_) { deviceLabel = ''; }
        try { console.warn('[reina-mic] recording started', { label: track.label, deviceId: track.getSettings?.()?.deviceId }); } catch (_) {}
        const mimeType = pickMimeType(Recorder);
        try { recorder = mimeType ? new Recorder(stream, { mimeType }) : new Recorder(stream); } catch (error) { fail(errorCode(error)); return false; }
        recorder.ondataavailable = (event) => { if (active && event?.data?.size > 0) chunks.push(event.data); };
        recorder.onerror = () => fail('unavailable');
        recorder.onstop = () => deliverRecording('stopped');
        deliverRecording = (reason) => {
          if (!active || delivered) return;
          delivered = true;
          if (timer !== null) clearTimer(timer); timer = null;
          if (cancelled) { finish(); return; }
          if (reason === 'stop-timeout') {
            try { console.warn('[reina-mic] recorder never reported stopping, delivering what it captured', { stopMs, chunks: chunks.length }); } catch (_) {}
            report({ stage: 'recorder-stop-timeout', code: 'recorder-stop-timeout', peak: peakSeen, chunks: chunks.length, msSinceStart: Math.max(0, Math.round(now() - startedAt)), deviceLabel: deviceLabel || undefined });
            // The tracks are what keep a wedged recorder alive. Release them
            // now rather than after transcription answers, so the next turn
            // opens a fresh microphone.
            stopTracks(stream); stream = null;
          }
          const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' });
          try { console.warn('[reina-mic] recording stopped, blob size', { bytes: blob.size, mimeType: recorder?.mimeType }); } catch (_) {}
          if (blob.size < 1024) { fail('no-speech', { audioBytes: blob.size, mimeType: recorder?.mimeType }); return; }
          if (sampled && clippedPolls > clippedPollsAllowed) {
            try { console.warn('[reina-mic] input is clipping', { peak: peakSeen, clippedPolls, clippingCeiling, deviceLabel }); } catch (_) {}
            fail('input-too-loud', { audioBytes: blob.size, mimeType: recorder?.mimeType, clippedPolls });
            return;
          }
          if (sampled && peakSeen < audibleFloor) {
            try { console.warn('[reina-mic] input too quiet to transcribe', { peak: peakSeen, audibleFloor, deviceLabel }); } catch (_) {}
            fail('input-too-quiet', { audioBytes: blob.size, mimeType: recorder?.mimeType });
            return;
          }
          // A transcription attempt that never answers is the one outcome
          // nothing could see: no transcript, no error, no console line, no
          // report -- the recording simply ends and the panel sits there. The
          // caller is supposed to bound itself, but "supposed to" is exactly
          // what produced a silent voice turn. Bound it here too, so every
          // recording reaches an outcome that says what happened.
          let answered = false;
          const answeredFirst = () => { if (answered || !active) return false; answered = true; if (deadline !== null) clearTimer(deadline); deadline = null; return true; };
          let deadline = setTimer(() => {
            if (!answeredFirst()) return;
            try { console.warn('[reina-mic] transcription never answered', { transcriptionMs, bytes: blob.size }); } catch (_) {}
            fail('transcription-timeout', {
              stage: 'transcription', audioBytes: blob.size, mimeType: recorder?.mimeType, msSinceStart: transcriptionMs,
            });
          }, transcriptionMs);
          Promise.resolve(transcribeAudio(blob)).then((reply) => {
            if (!answeredFirst()) return;
            if (reply && reply.ok === true && typeof reply.transcript === 'string' && reply.transcript.trim()) { result(reply.transcript.trim()); return; }
            // The route's own account of WHY there is no transcript. Without it
            // "no_speech" is ambiguous between a silent recording and a model
            // reply we refused, and those have opposite fixes.
            try {
              console.warn('[reina-mic] transcription request resolved without a usable transcript', {
                replyCode: reply?.code, replyType: typeof reply, diagnostic: reply?.diagnostic ?? null,
              });
            } catch (_) {}
            const replyCode = typeof reply?.code === 'string' && /^[a-z0-9_-]{1,80}$/i.test(reply.code)
              ? reply.code.replaceAll('_', '-') : 'unavailable';
            // A recording DID reach the route and the route could not turn it
            // into words. That is not the same failure as a microphone that
            // captured nothing (the blob-size check above), and telling a user
            // who just spoke a full sentence "I did not hear anything -- select
            // Enable Hands-free" sends them to fix the one thing that worked.
            fail(replyCode === 'no-speech' ? 'transcription-no-speech' : replyCode, {
              stage: 'transcription',
              audioBytes: blob.size,
              mimeType: recorder?.mimeType,
              replyCode: reply?.code,
            });
          }, (networkError) => {
            if (!answeredFirst()) return;
            try {
              console.warn('[reina-mic] transcription request rejected', {
                code: networkError?.code,
                message: networkError?.message ?? String(networkError),
                name: networkError?.name,
              });
            } catch (_) {}
            // The upload itself failed, so nothing server-side can record it.
            // Name the client-side cause rather than collapsing every rejection
            // into "network": an expired token and a dead connection are not
            // the same problem.
            fail('network', {
              stage: 'transcription',
              audioBytes: blob.size,
              mimeType: recorder?.mimeType,
              replyCode: typeof networkError?.code === 'string' ? networkError.code : undefined,
            });
          });
        };
        try { recorder.start(250); } catch (error) { fail(errorCode(error)); return false; }
        if (recorder.state !== 'recording') { fail('unavailable'); return false; }
        if (startupTimer !== null) { clearTimer(startupTimer); startupTimer = null; }
        emit('onstart', {});
        beginSilenceDetection();
        timer = setTimer(requestStop, maximumMs);
        return true;
      }, (error) => { fail(errorCode(error)); return false; });
    };
    instance.stop = requestStop;
    instance.abort = () => { cancelled = true; try { if (recorder?.state === 'recording') recorder.stop(); } catch (_) {} finish(); };
    return instance;
  };
}

if (typeof window !== 'undefined') window.ReinaControlledTranscription = { createControlledTranscriptionRecognitionFactory };
