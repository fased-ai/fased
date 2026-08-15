package platform

import (
	"errors"
	"fmt"
)

const FixedBootstrapPath = "/opt/fased/lifecycle/bootstrap-v1/fased-bootstrap"

// RenderUpdateAuthority grants the installed operator only the stable,
// root-owned managed lifecycle entry points for its bound platform profile.
// Status is read-only; update, repair, rollback, and uninstall enter bounded Go
// transactions. Managed uninstall preserves owner and signer state; rollback
// additionally requires a short-lived threshold root-signed authorization.
func RenderUpdateAuthority(config Config, operatorUser string) ([]byte, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	if !accountNamePattern.MatchString(operatorUser) || operatorUser == "root" {
		return nil, errors.New("update operator identity is invalid")
	}
	bootstrap := config.BootstrapHostPath()
	return []byte(fmt.Sprintf(
		"%s ALL=(root) NOPASSWD: %s update --profile %s *\n%s ALL=(root) NOPASSWD: %s repair --profile %s *\n%s ALL=(root) NOPASSWD: %s rollback --profile %s *\n%s ALL=(root) NOPASSWD: %s uninstall --profile %s *\n%s ALL=(root) NOPASSWD: %s status --profile %s *\n",
		operatorUser, bootstrap, config.Profile,
		operatorUser, bootstrap, config.Profile,
		operatorUser, bootstrap, config.Profile,
		operatorUser, bootstrap, config.Profile,
		operatorUser, bootstrap, config.Profile,
	)), nil
}
