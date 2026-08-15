package platform

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"sort"
	"strings"
)

type launchdPlistSpec struct {
	Label, User, Group, WorkingDirectory, StdoutPath, StderrPath string
	ProgramArguments                                             []string
	Environment                                                  map[string]string
	Umask                                                        uint32
}

func renderLaunchdPlist(spec launchdPlistSpec) ([]byte, error) {
	if !launchdLabelPattern.MatchString(spec.Label) || spec.User == "" || spec.Group == "" || len(spec.ProgramArguments) == 0 ||
		!filepath.IsAbs(spec.ProgramArguments[0]) || spec.Umask > 0o777 ||
		(spec.WorkingDirectory != "" && !filepath.IsAbs(spec.WorkingDirectory)) || !filepath.IsAbs(spec.StdoutPath) || !filepath.IsAbs(spec.StderrPath) {
		return nil, errors.New("launchd service definition is incomplete")
	}
	var out strings.Builder
	out.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
	out.WriteString("<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n")
	out.WriteString("<plist version=\"1.0\"><dict>\n")
	writePlistString(&out, "Label", spec.Label)
	out.WriteString("<key>ProgramArguments</key><array>\n")
	for _, argument := range spec.ProgramArguments {
		out.WriteString("<string>" + xmlText(argument) + "</string>\n")
	}
	out.WriteString("</array>\n")
	writePlistString(&out, "UserName", spec.User)
	writePlistString(&out, "GroupName", spec.Group)
	if spec.WorkingDirectory != "" {
		writePlistString(&out, "WorkingDirectory", spec.WorkingDirectory)
	}
	if len(spec.Environment) > 0 {
		out.WriteString("<key>EnvironmentVariables</key><dict>\n")
		keys := make([]string, 0, len(spec.Environment))
		for key := range spec.Environment {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			writePlistString(&out, key, spec.Environment[key])
		}
		out.WriteString("</dict>\n")
	}
	fmt.Fprintf(&out, "<key>Umask</key><integer>%d</integer>\n", spec.Umask)
	writePlistString(&out, "StandardOutPath", spec.StdoutPath)
	writePlistString(&out, "StandardErrorPath", spec.StderrPath)
	out.WriteString("<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>ProcessType</key><string>Background</string>\n")
	out.WriteString("</dict></plist>\n")
	return []byte(out.String()), nil
}

func writePlistString(out *strings.Builder, key, value string) {
	out.WriteString("<key>" + xmlText(key) + "</key><string>" + xmlText(value) + "</string>\n")
}

func xmlText(value string) string {
	var out bytes.Buffer
	_ = xml.EscapeText(&out, []byte(value))
	return out.String()
}

func launchdProgram(data []byte, expectedLabel string) (string, error) {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	key, label, program := "", "", ""
	inProgramArguments := false
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", err
		}
		switch value := token.(type) {
		case xml.StartElement:
			switch value.Name.Local {
			case "key":
				if err := decoder.DecodeElement(&key, &value); err != nil {
					return "", err
				}
			case "array":
				inProgramArguments = key == "ProgramArguments"
				key = ""
			case "string":
				var text string
				if err := decoder.DecodeElement(&text, &value); err != nil {
					return "", err
				}
				if key == "Label" {
					label = text
				}
				if inProgramArguments && program == "" {
					program = text
				}
				key = ""
			}
		case xml.EndElement:
			if value.Name.Local == "array" {
				inProgramArguments = false
			}
		}
	}
	if label != expectedLabel || !filepath.IsAbs(program) || strings.ContainsRune(program, 0) {
		return "", errors.New("launchd plist label or program is invalid")
	}
	return program, nil
}
