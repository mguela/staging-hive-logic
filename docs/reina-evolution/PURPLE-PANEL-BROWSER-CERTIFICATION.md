# Reina V12.1 Purple-Panel Browser Certification Gate

Label: **STRICT BROWSER INTEGRATION GATE - NOT PRODUCTION CERTIFICATION WITHOUT ARMED CANDIDATE**

## V12.1 correction

Armed certification previously false-PASSed inadequate candidates because aggregation used silent safe defaults (`!== false`) and `runArmedBrowserCertification` omitted `matchBrowserFinal`.

V12.1 requires for **every** scenario:

1. `matchBrowserFinal()` — strict own-data properties, correct primitive types, exact values
2. `criticalBrowserMatch()`
3. `evaluateBrowserReleaseBlockers()`

Missing structural audit fields **fail**. Absence is not proof that nothing executed.

## Explicit statements

1. Known-good / reference hard-pass is **NOT** production certification.
2. Certification is **DORMANT** until `REINA_BROWSER_CANDIDATE_MODULE` is set.
3. Reference stubs are rejected (`PRODUCTION_CERT_FORBIDDEN`).
4. Inadequate candidate (all hooks `{}` except sparse panel/speech) **must FAIL**.

## Contract

```bash
export REINA_BROWSER_CANDIDATE_MODULE=/absolute/path/to/reina-browser-hooks.mjs
```

```js
export function createReinaBrowserCandidateHooks() { /* 12 hooks */ }
```

Stimulus only. Explicit evidence required for every expected field.

## Run

```bash
node --test test/reina-purple-panel-browser-certification.test.mjs
```
