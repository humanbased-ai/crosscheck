# Short cut -> assets/demo-block-to-approve.gif
#
# The README first viewport needs a GIF that loops quickly and stays small, so this
# records `demo:play --short`: the setup, the first finding, and the closing state,
# without the intermediate rounds the mp4 walks through.
#
# Smaller than the mp4 cut on purpose — 1000px at 10fps keeps the GIF loadable on a
# README while staying legible; the mp4 carries the full-resolution version.

Output assets/demo-block-to-approve.gif

Set Shell     "bash"
Set FontSize  15
Set Width     1000
Set Height    640
Set Padding   20
Set Theme     "Catppuccin Mocha"
Set Framerate 10
Set TypingSpeed 1ms

Hide
Type "clear && npm run --silent demo:play -- --short" Enter
Sleep 800ms
Show

Sleep 34s

Hide
Type "clear" Enter
Show
Sleep 300ms
