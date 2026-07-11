Output "demo.gif"

Set Shell bash
Set FontSize 18
Set Width 1200
Set Height 720
Set TypingSpeed 35ms
Set PlaybackSpeed 1

# Start from docs/demo so `vhs demo.tape` works as documented.
Hide
Type "cd ../.."
Enter
Sleep 1s
Show

# Scene 1: generate the fixture portfolio and scan it.
Type "npm run fixtures:gen && node tools/sma-scan.ts --root tools/evals/fixtures/portfolio --out /tmp/demo-registry.json"
Enter
Sleep 5s

# Scene 2: show the compact brick summary from the generated registry.
Type `node -e 'const r=require("/tmp/demo-registry.json"); console.log({bricks:r.count, projects:r.projects.length, warnings:r.validation_warning_count, failures:r.failure_count, readiness:r.scanner_report.readiness.average_score})'`
Enter
Sleep 3s
Ctrl+L
Sleep 1s

# Scene 3: one agent claims the brick; the second gets a graceful conflict.
Type `SMA_AGENT=agent-a npm run start:edit -- --project sma --brick demo-brick --intent "wire the demo"`
Enter
Sleep 4s
Type `SMA_AGENT=agent-b npm run start:edit -- --project sma --brick demo-brick --intent "wire the demo"`
Enter
Sleep 5s
