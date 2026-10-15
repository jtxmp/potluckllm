# Records the README demo GIF. From the repo root:
#   vhs demo/demo.tape
# Needs vhs and ttyd on PATH, plus everything demo/drive.sh needs.
Output demo/demo.gif

Set Shell "bash"
Set FontFamily "Source Code Pro"
Set FontSize 14
Set Width 1600
Set Height 820
Set Padding 12
Set Framerate 20
Set Theme "Builtin Dark"

Hide
Type "PS1='' bash demo/drive.sh" Enter
Sleep 2s
Show

Wait+Screen@240s /rejected by laptop A/
Sleep 3s
