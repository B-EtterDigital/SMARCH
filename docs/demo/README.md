# SMARCH terminal demo

This demo uses [VHS](https://github.com/charmbracelet/vhs) to record a deterministic terminal walkthrough of fixture scanning and SMA edit collision handling.

## Record it

Install `vhs`, then run from this directory:

```bash
cd docs/demo
vhs demo.tape
```

The tape writes `demo.gif` beside `demo.tape`. It fixes the terminal width, height, font size, typing speed, playback speed, and sleep-based pacing so repeated captures follow the same sequence.

The final scene intentionally leaves `agent-a` holding the `demo-brick` edit lease after `agent-b` receives the conflict message. Release or expire that demo lease before recording the tape again.

The root package can expose the same workflow with this requested script:

```json
{
  "demo:record": "cd docs/demo && vhs demo.tape"
}
```

No GIF should be checked in unless it was produced by running VHS locally.
