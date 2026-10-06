# herdr panes run inside Ghostty (cmux), which paints the kitty graphics
# protocol — but herdr changes the terminal identity (XTVERSION reports
# "libghostty"), so Claude Code's ["kitty","ghostty"] whitelist probe fails
# and images degrade to alt text. Force images on for claude inside herdr
# panes only; plain terminals keep their own probe.
if [ "$TERM_PROGRAM" = "herdr" ]; then
  export CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1
fi
