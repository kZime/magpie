package library

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClaudeSubagentImportKeepsOriginal(t *testing.T) {
	h := sandbox(t)
	dir := filepath.Join(h, "custom-claude")
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	source := "---\r\nname: reviewer\r\ndescription: |\r\n  Reviews code\r\n  carefully\r\nskills: [tdd]\r\nmcpServers:\r\n  - github\r\nmodel: sonnet\r\ntools: Read, Grep\r\n---\r\n\r\nReview 代码.\r\n"
	file := filepath.Join(dir, "agents", "reviewer.md")
	write(t, file, source)
	rows, err := PreviewClaudeSubagents()
	if err != nil || len(rows) != 1 || rows[0].Error != "" {
		t.Fatalf("preview: %#v %v", rows, err)
	}
	c := rows[0]
	if c.Subagent.Prompt != "Review 代码." || len(c.Unsupported) != 2 || len(c.Subagent.Skills) != 1 || len(c.Subagent.MCP) != 1 {
		t.Fatalf("preview data: %#v", c)
	}
	if _, err := os.Stat(path()); !os.IsNotExist(err) {
		t.Fatalf("preview wrote library: %v", err)
	}
	pick := []ClaudeSubagentSelection{{File: c.File, Hash: c.Hash}}
	ok(t)(ImportClaudeSubagents(pick))
	l, err := load()
	if err != nil {
		t.Fatal(err)
	}
	s := l.subagent("reviewer")
	if s == nil || len(s.Agents) != 0 {
		t.Fatalf("import should select no targets: %#v", s)
	}
	if _, err := ImportClaudeSubagents(pick); err == nil {
		t.Fatal("duplicate imported")
	}
	ok(t)(RemoveSubagents([]string{"reviewer"}))
	b, err := os.ReadFile(file)
	if err != nil || string(b) != source {
		t.Fatalf("source changed: %q %v", b, err)
	}
}

func TestClaudeSubagentImportRefusesStaleAndPartial(t *testing.T) {
	h := sandbox(t)
	dir := filepath.Join(h, ".claude/agents")
	write(t, filepath.Join(dir, "reviewer.md"), "---\nname: reviewer\ndescription: Review code\n---\nPrompt\n")
	rows, err := PreviewClaudeSubagents()
	if err != nil {
		t.Fatal(err)
	}
	c := rows[0]
	write(t, filepath.Join(dir, "reviewer.md"), "---\nname: reviewer\ndescription: Changed\n---\nPrompt\n")
	if _, err := ImportClaudeSubagents([]ClaudeSubagentSelection{{c.File, c.Hash}}); err == nil {
		t.Fatal("accepted stale preview")
	}
	rows, err = PreviewClaudeSubagents()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ImportClaudeSubagents([]ClaudeSubagentSelection{{rows[0].File, rows[0].Hash}, {"../escape.md", "x"}}); err == nil {
		t.Fatal("accepted unsafe filename")
	}
	l, err := load()
	if err != nil {
		t.Fatal(err)
	}
	if l.subagent("reviewer") != nil {
		t.Fatal("partially saved batch")
	}
}

func TestClaudeSubagentImportReportsInvalidFiles(t *testing.T) {
	h := sandbox(t)
	dir := filepath.Join(h, ".claude/agents")
	for n, b := range map[string]string{"plain.md": "No frontmatter", "bad.md": "---\nname: [\n---\nPrompt", "large.md": strings.Repeat("x", maxSubagentPrompt+16385)} {
		write(t, filepath.Join(dir, n), b)
	}
	rows, err := PreviewClaudeSubagents()
	if err != nil || len(rows) != 3 {
		t.Fatalf("preview %v %v", rows, err)
	}
	for _, c := range rows {
		if c.Error == "" {
			t.Errorf("missing error for %s", c.File)
		}
	}
}

func TestClaudeSubagentImportRejectsDuplicateBatch(t *testing.T) {
	h := sandbox(t)
	dir := filepath.Join(h, ".claude/agents")
	for _, name := range []string{"one.md", "two.md"} {
		write(t, filepath.Join(dir, name), "---\nname: reviewer\ndescription: Review code\n---\nPrompt\n")
	}
	rows, err := PreviewClaudeSubagents()
	if err != nil || len(rows) != 2 {
		t.Fatalf("preview: %#v %v", rows, err)
	}
	if _, err := ImportClaudeSubagents([]ClaudeSubagentSelection{{rows[0].File, rows[0].Hash}, {rows[1].File, rows[1].Hash}}); err == nil {
		t.Fatal("accepted duplicate names in one batch")
	}
	if _, err := os.Stat(path()); !os.IsNotExist(err) {
		t.Fatalf("failed batch wrote library: %v", err)
	}
}

func TestClaudeSubagentPreviewRejectsLinks(t *testing.T) {
	h := sandbox(t)
	file := filepath.Join(h, ".claude/agents/reviewer.md")
	write(t, file, "---\nname: reviewer\ndescription: Review code\n---\nPrompt\n")
	if err := os.Symlink(file, filepath.Join(filepath.Dir(file), "link.md")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	rows, err := PreviewClaudeSubagents()
	if err != nil || len(rows) != 2 {
		t.Fatalf("preview: %#v %v", rows, err)
	}
	for _, c := range rows {
		if c.File == "link.md" && c.Error == "" {
			t.Fatal("accepted a linked subagent")
		}
	}
}
