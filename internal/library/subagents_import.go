package library

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"gopkg.in/yaml.v3"
)

// ClaudeSubagentCandidate is a read-only preview. File is a basename, never
// a caller-selected path. Hash lets import refuse a file edited since preview.
type ClaudeSubagentCandidate struct {
	File        string    `json:"file"`
	Hash        string    `json:"hash"`
	Subagent    *Subagent `json:"subagent,omitempty"`
	Unsupported []string  `json:"unsupported,omitempty"`
	Error       string    `json:"error,omitempty"`
}

type ClaudeSubagentSelection struct {
	File string `json:"file"`
	Hash string `json:"hash"`
}

func readClaudeSubagent(file string) (ClaudeSubagentCandidate, error) {
	c := ClaudeSubagentCandidate{File: file}
	if filepath.Base(file) != file || strings.ContainsAny(file, `/\`) || !strings.HasSuffix(file, ".md") {
		return c, errors.New("invalid subagent filename")
	}
	path := filepath.Join(claudeDir(), "agents", file)
	fi, err := os.Lstat(path)
	if err != nil {
		return c, err
	}
	if !fi.Mode().IsRegular() {
		return c, errors.New("subagent must be a regular file, not a link")
	}
	f, err := os.Open(path)
	if err != nil {
		return c, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxSubagentPrompt+16385))
	if err != nil {
		return c, err
	}
	if len(b) > maxSubagentPrompt+16384 {
		return c, errors.New("subagent file is too large")
	}
	c.Hash = subagentHash(b)
	b = bytes.ReplaceAll(b, []byte("\r\n"), []byte("\n"))
	if !bytes.HasPrefix(b, []byte("---\n")) {
		return c, errors.New("missing YAML front matter")
	}
	end := bytes.Index(b[4:], []byte("\n---\n"))
	if end < 0 {
		return c, errors.New("missing end of YAML front matter")
	}
	var fields map[string]yaml.Node
	if err := yaml.Unmarshal(b[4:4+end], &fields); err != nil {
		return c, err
	}
	s := &Subagent{Agents: []string{}}
	for key, node := range fields {
		var target any
		switch key {
		case "name":
			target = &s.Name
		case "description":
			target = &s.Description
		case "skills":
			target = &s.Skills
		case "mcpServers":
			target = &s.MCP
		default:
			c.Unsupported = append(c.Unsupported, key)
			continue
		}
		if err := node.Decode(target); err != nil {
			return c, fmt.Errorf("%s: %w", key, err)
		}
	}
	s.Prompt = strings.TrimSpace(string(b[4+end+5:]))
	if err := s.check(); err != nil {
		return c, err
	}
	slices.Sort(c.Unsupported)
	c.Subagent = s
	return c, nil
}

// PreviewClaudeSubagents reads the user's Claude folder without writing or
// taking ownership of any definition, including ones magpie cannot represent.
func PreviewClaudeSubagents() ([]ClaudeSubagentCandidate, error) {
	entries, err := os.ReadDir(filepath.Join(claudeDir(), "agents"))
	if os.IsNotExist(err) {
		return []ClaudeSubagentCandidate{}, nil
	}
	if err != nil {
		return nil, err
	}
	mu.Lock()
	defer mu.Unlock()
	l, err := load()
	if err != nil {
		return nil, err
	}
	out := []ClaudeSubagentCandidate{}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		c, err := readClaudeSubagent(e.Name())
		if err != nil {
			c.Error = err.Error()
		} else if l.subagent(c.Subagent.Name) != nil {
			c.Error = "a subagent with this name is already in the library"
		}
		out = append(out, c)
	}
	return out, nil
}

// ImportClaudeSubagents copies the selected preview into the library only.
// No agent is selected: the source remains the user's, never adopted by sync.
func ImportClaudeSubagents(picks []ClaudeSubagentSelection) (*Result, error) {
	if len(picks) == 0 {
		return nil, errors.New("no subagents selected")
	}
	return change(func(l *Library) error {
		pending := []*Subagent{}
		seen := map[string]bool{}
		for _, p := range picks {
			c, err := readClaudeSubagent(p.File)
			if err != nil {
				return fmt.Errorf("%s: %w", p.File, err)
			}
			if p.Hash == "" || c.Hash != p.Hash {
				return fmt.Errorf("%s changed; preview it again", p.File)
			}
			if l.subagent(c.Subagent.Name) != nil || seen[c.Subagent.Name] {
				return fmt.Errorf("the library already has a subagent called %s", c.Subagent.Name)
			}
			seen[c.Subagent.Name] = true
			pending = append(pending, c.Subagent)
		}
		l.Subagents = append(l.Subagents, pending...)
		return nil
	})
}
