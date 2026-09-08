# Full cut -> assets/demo-block-to-approve.mp4
#
#   npm run demo:record          # records both cuts
#
# Needs vhs (brew install vhs). Everything it runs is offline: demo:play reads the
# committed demo/arc.json and makes no network calls, so the recording is
# reproducible on any machine. See demo/README.md for what is real here.

Output assets/demo-block-to-approve.mp4

Set Shell     "bash"
Set FontSize  15
Set Width     1280
Set Height    800
Set Padding   24
Set Theme     "Catppuccin Mocha"
Set Framerate 12
Set TypingSpeed 1ms

# The replay types its own prompts at its own pace, so vhs types nothing visible;
# hiding the launch keeps the shell's startup out of the first frames.
Hide
Type "clear && npm run --silent demo:play" Enter
Sleep 800ms
Show

# Must outlast the replay. vhs stops at the last Sleep, so an over-estimate adds
# idle trailing frames and an under-estimate truncates the ending — `npm run
# demo:time` prints the measured length to set this from.
Sleep 86s

Hide
Type "clear" Enter
Show
Sleep 400ms
