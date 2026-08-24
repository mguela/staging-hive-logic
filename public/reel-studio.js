/* public/reel-studio.js
 * The renderer: turns a reel's frames + narration into a real video file.
 *
 * WHY THIS RUNS IN THE BROWSER AND NOT ON THE SERVER
 * Vercel serverless has no ffmpeg binary, a hard bundle-size ceiling, and a
 * seconds-long execution budget. The browser, meanwhile, ships a hardware
 * video encoder that any laptop can drive in real time: canvas.captureStream()
 * gives a live video track, AudioContext gives a synchronized audio track, and
 * MediaRecorder muxes the two into a file. So the server prepares the material
 * and this file does the edit.
 *
 * OUTPUT FORMAT, and why it is checked rather than assumed
 * Chrome can record straight to MP4 (H.264/AAC) and MP4 is what Instagram
 * Reels requires. Where MP4 recording is unavailable this falls back to WebM,
 * which TikTok accepts but Instagram does not -- so the format actually used
 * is reported back to the operator rather than quietly downgraded.
 *
 * THE CRAFT, since a slideshow and a film differ only in these details:
 *   - shot lengths are derived from the narration's own word distribution, so
 *     a caption is on screen exactly while its line is being spoken;
 *   - every shot has a slow Ken Burns move on an ease curve, alternating
 *     direction so consecutive shots never drift the same way;
 *   - shots cross-dissolve rather than cut, with an eased opacity ramp;
 *   - captions rise and fade on a spring-ish ease, over a bottom scrim that
 *     keeps text legible on any photo;
 *   - a title card opens and an end card closes, both on the brand palette;
 *   - the whole thing is graded with a subtle vignette and a warm lift so
 *     mixed phone-camera photography reads as one piece.
 */
(function () {
  'use strict';

  // Brand palette, matched to the Marketing Command Center's :root tokens so
  // a rendered film and the app it came from are visibly the same product.
  var BRAND = {
    navy: '#161e2e',
    navy2: '#25304a',
    slate: '#748a9e',
    slateDeep: '#59718a',
    cream: '#f0f1f6',
    ink: '#484f64',
  };

  var PRESETS = {
    reel: { width: 1080, height: 1920, fps: 30, titleSeconds: 1.6, endSeconds: 2.2 },
    commercial: { width: 1920, height: 1080, fps: 30, titleSeconds: 2.6, endSeconds: 3.4 }
  };

  // ---- easing -------------------------------------------------------
  function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function clamp01(t) { return t < 0 ? 0 : (t > 1 ? 1 : t); }

  // ---- asset loading ------------------------------------------------
  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      // Frames come from Supabase Storage on a different origin. Without this
      // the canvas is tainted and captureStream() produces a black video.
      img.crossOrigin = 'anonymous';
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('Could not load frame: ' + url)); };
      img.src = url;
    });
  }

  function loadAudioBuffer(ctx, url) {
    return fetch(url, { mode: 'cors' })
      .then(function (r) {
        if (!r.ok) throw new Error('Could not load the voiceover (' + r.status + ').');
        return r.arrayBuffer();
      })
      .then(function (buf) { return ctx.decodeAudioData(buf); });
  }

  // ---- timing -------------------------------------------------------
  // Shot lengths follow the narration's own word distribution, so each caption
  // is on screen while its line is spoken. This is what separates a cut that
  // lands from a slideshow that happens to have audio over it.
  function buildTimeline(script, narrationSeconds, preset) {
    var beats = (script && script.beats) || [];
    var hookWords = wordCount(script && script.hook);
    var beatWords = beats.map(function (b) { return wordCount(b.say); });
    var totalWords = hookWords + beatWords.reduce(function (a, b) { return a + b; }, 0);

    // The narration audio starts under the title card, so the title's length
    // is charged against the hook's share rather than added on top -- adding
    // it would drift every later caption out of sync with the voice.
    var spokenSeconds = Math.max(narrationSeconds, 1);
    var perWord = totalWords > 0 ? spokenSeconds / totalWords : spokenSeconds / Math.max(beats.length, 1);

    var shots = [];
    var t = 0;
    var titleSeconds = Math.min(preset.titleSeconds, hookWords * perWord);
    shots.push({ type: 'title', start: 0, duration: titleSeconds, text: (script && script.hook) || '' });
    t = titleSeconds;

    // Whatever is left of the hook's spoken time plays over the first frame.
    var hookRemainder = Math.max(hookWords * perWord - titleSeconds, 0);
    for (var i = 0; i < beats.length; i++) {
      var d = beatWords[i] * perWord + (i === 0 ? hookRemainder : 0);
      shots.push({
        type: 'frame',
        frameIndex: i,
        start: t,
        duration: Math.max(d, 1.2),
        text: beats[i].onScreenText || ''
      });
      t += Math.max(d, 1.2);
    }
    shots.push({ type: 'end', start: t, duration: preset.endSeconds, text: '' });
    return { shots: shots, totalSeconds: t + preset.endSeconds };
  }

  function wordCount(s) {
    return String(s || '').trim().split(/\s+/).filter(Boolean).length;
  }

  // ---- drawing ------------------------------------------------------
  // Cover-fit with a Ken Burns move. `progress` is 0..1 through the shot;
  // `dir` alternates per shot so consecutive images never drift the same way.
  //
  // The SIZE of the move is chosen from how much the source actually overflows
  // the frame, and that is not a refinement -- it is the difference between a
  // film and an unreadable one. A phone photo is far larger than the frame, so
  // a real push costs it nothing. A screen capture is the same size as the
  // frame, so the same push crops away the very interface the shot exists to
  // show. The first cut of this renderer used one setting for both and sheared
  // the navigation off every product shot.
  function drawFrame(ctx, img, W, H, progress, dir) {
    var e = easeInOutCubic(clamp01(progress));

    var base = Math.max(W / img.width, H / img.height);
    var overflow = (img.width * base) / W;      // 1.0 when it exactly covers
    var zoomTo = overflow > 1.25 ? 1.16 : 1.045;
    var zoom = 1 + (zoomTo - 1) * e;

    var scale = base * zoom;
    var dw = img.width * scale;
    var dh = img.height * scale;

    // Centred, with a small drift either side of centre -- never anchored to
    // an edge, which is what threw the subject out of frame before.
    var slackX = Math.max(dw - W, 0);
    var slackY = Math.max(dh - H, 0);
    var swing = (e - 0.5) * 2;                  // -1 .. +1 across the shot
    var dx = (W - dw) / 2 + (dir % 2 === 0 ? 1 : -1) * Math.min(slackX / 2, W * 0.025) * swing;
    var dy = (H - dh) / 2 + (dir % 4 < 2 ? 1 : -1) * Math.min(slackY / 2, H * 0.025) * swing;

    ctx.drawImage(img, dx, dy, dw, dh);
  }

  // A warm lift plus a vignette. Mixed phone-camera photography shot by
  // different techs on different days reads as one film once it shares a
  // single grade; without this the cuts look like a shared album.
  function grade(ctx, W, H) {
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = 'rgba(116,138,158,0.10)';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    var r = Math.max(W, H) * 0.75;
    var vign = ctx.createRadialGradient(W / 2, H / 2, r * 0.35, W / 2, H / 2, r);
    vign.addColorStop(0, 'rgba(0,0,0,0)');
    vign.addColorStop(1, 'rgba(10,14,24,0.42)');
    ctx.fillStyle = vign;
    ctx.fillRect(0, 0, W, H);
  }

  function wrapLines(ctx, text, maxWidth) {
    var words = String(text || '').split(/\s+/).filter(Boolean);
    var lines = [];
    var line = '';
    for (var i = 0; i < words.length; i++) {
      var probe = line ? line + ' ' + words[i] : words[i];
      if (ctx.measureText(probe).width > maxWidth && line) {
        lines.push(line);
        line = words[i];
      } else {
        line = probe;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  // Caption over a bottom scrim. The scrim is what makes white text legible
  // on a bright "after" photo, and the rise-and-fade is what stops each
  // caption from feeling stapled on.
  function drawCaption(ctx, text, W, H, shotProgress, isVertical) {
    if (!text) return;
    var appear = easeOutCubic(clamp01(shotProgress / 0.18));
    var leave = 1 - easeOutCubic(clamp01((shotProgress - 0.86) / 0.14));
    var alpha = Math.min(appear, leave);
    if (alpha <= 0.01) return;

    var pad = Math.round(W * 0.075);
    var fontSize = Math.round(isVertical ? W * 0.062 : W * 0.036);
    ctx.font = '700 ' + fontSize + 'px Montserrat, "Segoe UI", -apple-system, sans-serif';
    var lines = wrapLines(ctx, text.toUpperCase(), W - pad * 2);
    var lineHeight = Math.round(fontSize * 1.22);
    var blockH = lines.length * lineHeight;
    var baseY = H - Math.round(H * (isVertical ? 0.16 : 0.13)) - blockH;
    var rise = (1 - appear) * fontSize * 0.7;

    // Scrim, sized to the text block rather than a fixed band. Weighted for
    // the WORST case rather than the average one: a bright "after" photo or a
    // white app screen is where white type disappears, and a scrim tuned on a
    // dark frame looks right up until the moment it is used on a light one.
    var scrimTop = baseY - fontSize * 1.9;
    var scrim = ctx.createLinearGradient(0, scrimTop, 0, H);
    scrim.addColorStop(0, 'rgba(22,30,46,0)');
    scrim.addColorStop(0.35, 'rgba(22,30,46,0.72)');
    scrim.addColorStop(1, 'rgba(22,30,46,0.95)');
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = scrim;
    ctx.fillRect(0, scrimTop, W, H - scrimTop);
    // A solid floor under the type itself, so contrast never depends on what
    // the picture behind it happens to be doing.
    ctx.fillStyle = 'rgba(22,30,46,0.80)';
    ctx.fillRect(0, baseY - fontSize * 0.55, W, blockH + fontSize * 1.1);

    // Brand rule above the text -- a small thing that reads as art direction.
    ctx.fillStyle = BRAND.slate;
    ctx.fillRect(pad, baseY - fontSize * 0.85 + rise, Math.round(W * 0.09), Math.max(3, Math.round(H * 0.0035)));

    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'top';
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = Math.round(fontSize * 0.5);
    for (var i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], pad, baseY + i * lineHeight + rise);
    }
    ctx.restore();
  }

  function drawTitleCard(ctx, text, W, H, progress, isVertical) {
    var g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, BRAND.navy);
    g.addColorStop(1, BRAND.navy2);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    var appear = easeOutCubic(clamp01(progress / 0.35));
    var pad = Math.round(W * 0.09);
    var fontSize = Math.round(isVertical ? W * 0.082 : W * 0.048);
    ctx.font = '800 ' + fontSize + 'px Montserrat, "Segoe UI", -apple-system, sans-serif';
    var lines = wrapLines(ctx, text, W - pad * 2);
    var lineHeight = Math.round(fontSize * 1.18);
    var blockH = lines.length * lineHeight;
    var y = Math.round(H / 2 - blockH / 2);

    ctx.save();
    ctx.globalAlpha = appear;
    ctx.fillStyle = BRAND.slate;
    ctx.fillRect(pad, y - fontSize * 0.75, Math.round(W * 0.12 * appear), Math.max(4, Math.round(H * 0.005)));
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'top';
    for (var i = 0; i < lines.length; i++) {
      ctx.globalAlpha = appear * clamp01((progress - i * 0.06) / 0.3 + 0.2);
      ctx.fillText(lines[i], pad, y + i * lineHeight + (1 - appear) * fontSize * 0.5);
    }
    ctx.restore();
  }

  function drawEndCard(ctx, opts, W, H, progress, isVertical) {
    var g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, BRAND.navy);
    g.addColorStop(1, BRAND.navy2);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    var appear = easeOutCubic(clamp01(progress / 0.4));
    var cx = W / 2;
    var titleSize = Math.round(isVertical ? W * 0.088 : W * 0.05);
    var subSize = Math.round(titleSize * 0.42);

    ctx.save();
    ctx.globalAlpha = appear;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Hex lockup, drawn rather than loaded so the render needs no image asset.
    var r = titleSize * 0.85;
    var cy = H / 2 - titleSize * 1.35;
    ctx.beginPath();
    for (var i = 0; i < 6; i++) {
      var a = Math.PI / 180 * (60 * i - 30);
      var x = cx + r * Math.cos(a);
      var y = cy + r * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = BRAND.slate;
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = '800 ' + titleSize + 'px Montserrat, "Segoe UI", -apple-system, sans-serif';
    ctx.fillText(opts.brandName || '', cx, H / 2 + titleSize * 0.15);

    ctx.fillStyle = BRAND.cream;
    ctx.font = '600 ' + subSize + 'px Montserrat, "Segoe UI", -apple-system, sans-serif';
    ctx.fillText(opts.tagline || '', cx, H / 2 + titleSize * 1.05);
    ctx.restore();
  }

  // ---- the render ---------------------------------------------------
  // Real-time capture: the canvas is drawn on rAF while MediaRecorder pulls
  // from its stream and the AudioContext plays the narration into the same
  // recording. Real time is the point -- it is what keeps picture and sound
  // locked without a muxing step this environment cannot perform.
  function renderReel(opts) {
    var preset = PRESETS[opts.kind === 'commercial' ? 'commercial' : 'reel'];
    var W = preset.width, H = preset.height;
    var isVertical = H > W;
    var onProgress = opts.onProgress || function () {};

    var canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    var ctx = canvas.getContext('2d', { alpha: false });

    var audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    return Promise.all([
      Promise.all((opts.frames || []).map(function (f) { return loadImage(f.url); })),
      opts.voiceUrl ? loadAudioBuffer(audioCtx, opts.voiceUrl) : Promise.resolve(null)
    ]).then(function (loaded) {
      var images = loaded[0];
      var audioBuffer = loaded[1];
      if (!images.length) throw new Error('This reel has no frames to render.');

      // The voiceover's own length is the edit's clock. Where there is no
      // voiceover yet, an explicit intended runtime may be supplied (a script
      // has a known word count, so its runtime is known before it is recorded)
      // -- otherwise fall back to a flat few seconds per frame.
      var narrationSeconds = audioBuffer ? audioBuffer.duration
        : (opts.narrationSeconds || Math.max(images.length * 3, 6));
      var timeline = buildTimeline(opts.script, narrationSeconds, preset);

      var videoStream = canvas.captureStream(preset.fps);
      var tracks = videoStream.getVideoTracks();

      var source = null;
      if (audioBuffer) {
        var dest = audioCtx.createMediaStreamDestination();
        source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        // A gentle master gain: TTS output is hot, and leaving headroom keeps
        // the mix from clipping once a platform re-encodes it.
        var gain = audioCtx.createGain();
        gain.gain.value = 0.9;
        source.connect(gain).connect(dest);
        tracks = tracks.concat(dest.stream.getAudioTracks());
      }
      var stream = new MediaStream(tracks);

      var mime = pickMimeType();
      var recorder = new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: opts.kind === 'commercial' ? 12000000 : 8000000,
        audioBitsPerSecond: 192000
      });
      var chunks = [];
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };

      return new Promise(function (resolve, reject) {
        recorder.onerror = function (e) { reject(new Error('Recording failed: ' + (e.error && e.error.name))); };
        recorder.onstop = function () {
          try { audioCtx.close(); } catch (err) { /* already closed */ }
          resolve({ blob: new Blob(chunks, { type: mime.split(';')[0] }), mimeType: mime.split(';')[0], durationSeconds: timeline.totalSeconds });
        };

        recorder.start(250);
        if (source) source.start();
        var startedAt = performance.now();

        function tick() {
          var elapsed = (performance.now() - startedAt) / 1000;
          if (elapsed >= timeline.totalSeconds) {
            drawAt(timeline.totalSeconds - 0.001);
            recorder.stop();
            onProgress(1);
            return;
          }
          drawAt(elapsed);
          onProgress(elapsed / timeline.totalSeconds);
          requestAnimationFrame(tick);
        }

        function drawAt(t) {
          ctx.fillStyle = BRAND.navy;
          ctx.fillRect(0, 0, W, H);

          var shot = shotAt(timeline.shots, t);
          var p = clamp01((t - shot.start) / shot.duration);

          if (shot.type === 'title') {
            drawTitleCard(ctx, shot.text, W, H, p, isVertical);
          } else if (shot.type === 'end') {
            drawEndCard(ctx, opts, W, H, p, isVertical);
          } else {
            var img = images[Math.min(shot.frameIndex, images.length - 1)];
            drawFrame(ctx, img, W, H, p, shot.frameIndex);
            grade(ctx, W, H);
            drawCaption(ctx, shot.text, W, H, p, isVertical);
          }

          // Cross-dissolve: the outgoing shot is painted over the incoming one
          // for the last 0.45s, so cuts breathe instead of snapping.
          var DISSOLVE = 0.45;
          var next = shotAfter(timeline.shots, shot);
          var intoNext = t - (shot.start + shot.duration - DISSOLVE);
          if (next && intoNext > 0) {
            var a = easeInOutCubic(clamp01(intoNext / DISSOLVE));
            ctx.save();
            ctx.globalAlpha = a;
            if (next.type === 'end') {
              drawEndCard(ctx, opts, W, H, 0, isVertical);
            } else if (next.type === 'title') {
              drawTitleCard(ctx, next.text, W, H, 0, isVertical);
            } else {
              var nimg = images[Math.min(next.frameIndex, images.length - 1)];
              drawFrame(ctx, nimg, W, H, 0, next.frameIndex);
              grade(ctx, W, H);
            }
            ctx.restore();
          }
        }

        requestAnimationFrame(tick);
      });
    });
  }

  function shotAt(shots, t) {
    for (var i = shots.length - 1; i >= 0; i--) {
      if (t >= shots[i].start) return shots[i];
    }
    return shots[0];
  }

  function shotAfter(shots, shot) {
    var i = shots.indexOf(shot);
    return i >= 0 && i < shots.length - 1 ? shots[i + 1] : null;
  }

  // MP4 first: Instagram Reels requires it and Chrome can record it directly.
  // WebM is a real fallback, not an equivalent -- the caller is told which
  // one it got so it can warn before a post to a surface that rejects WebM.
  function pickMimeType() {
    var candidates = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm'
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    throw new Error('This browser cannot record video. Try Chrome.');
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onloadend = function () { resolve(String(reader.result).split(',')[1]); };
      reader.onerror = function () { reject(new Error('Could not read the rendered video.')); };
      reader.readAsDataURL(blob);
    });
  }

  window.HLReelStudio = {
    render: renderReel,
    blobToBase64: blobToBase64,
    pickMimeType: pickMimeType,
    buildTimeline: buildTimeline,
    PRESETS: PRESETS
  };
})();
