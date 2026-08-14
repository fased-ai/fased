package platform

import (
	"errors"
	"fmt"
)

const FixedBootstrapPath = "/opt/fased/lifecycle/bootstrap-v1/fased-bootstrap"

// RenderUpdateAuthority grants the installed operator only the stable,
// root-owned managed-update entry point for its bound platform profile. The
// bootstrap parser rejects topology selectors and verifies every target before
// mutation.
func RenderUpdateAuthority(config Config, operatorUser string) ([]byte, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	if !accountNamePattern.MatchString(operatorUser) || operatorUser == "root" {
		return nil, errors.New("update operator identity is invalid")
	}
	return []byte(fmt.Sprintf("%s ALL=(root) NOPASSWD: %s update --profile %s *\n",
		operatorUser, FixedBootstrapPath, config.Profile)), nil
}
