# Records docs/assets/demo.gif: a real Claude Code session using the superPDF MCP server on the two sample invoices in
# this folder. Run from the repository root with VHS (https://github.com/charmbracelet/vhs):
#   vhs docs/demo/demo.tape
# Needs Node.js 22+, `npm install`, Claude Code signed in to your account, and VHS (brew install vhs).

Output docs/assets/demo.gif

Set Shell "bash"
Set FontSize 20
Set Width 1240
Set Height 820
Set Padding 18
Set Theme "GitHub Dark"
Set WindowBar Colorful
Set TypingSpeed 22ms

# Off camera: copy the invoices to ~/invoices (delete it afterwards) and point Claude Code at this repository's MCP server for that folder.
Hide
Type "export REPO=$PWD; for v in $(env | grep -o '^CLAUDE[A-Z_]*'); do unset $v; done; mkdir -p ~/invoices && cp docs/demo/invoice-104*.pdf ~/invoices/ && cd ~/invoices" Enter
Type `printf '{"mcpServers":{"superpdf":{"command":"node","args":["%s/bin/superpdf.js","mcp","--allow-dir","%s"]}}}' "$REPO" "$PWD" > mcp.json` Enter
Type "export PS1='~/invoices $ '; clear" Enter
Show

Type "ls *.pdf" Enter
Sleep 1.5s
Type "claude --mcp-config mcp.json --strict-mcp-config --permission-mode default --allowedTools mcp__superpdf" Enter
# Claude Code asks once whether to trust a new folder: choose "Yes, I trust this folder" (off camera; it shows the
# full home path).
Hide
Sleep 7s
Down
Sleep 0.5s
Enter
Sleep 3s
Show
Type "Combine invoice-1042.pdf and invoice-1043.pdf into invoices-april.pdf, then give me a table of each invoice's vendor, number, due date and total due."
Sleep 0.5s
Enter
Sleep 16s
