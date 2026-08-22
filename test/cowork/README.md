# Cowork end-to-end harness

Runs the real `public/hiveconnect/cowork-markup.js` + `draw.js` inside two
jsdom "participants" wired by a simulated LiveKit data channel, and asserts the
whole pipeline: coordinate alignment (presenter viewport <-> viewer video rect),
the annotate-permission handshake, control grant/release, revoke-on-share-stop,
the control relay (driving click -> control frame + ping), and shareVideoRect
video selection.

## Run
    npm i jsdom            # one-time (dev only; not a runtime dep)
    node test/cowork/harness.cjs

Exits non-zero on any failure. It exercises `window.CoworkMarkup._test`, a hook
exposed at the bottom of cowork-markup.js for automated testing (inert in prod).

NOTE: this cannot test the native desktop agent's OS input injection (that needs
real hardware) — only the browser/protocol logic up to the agent boundary.
