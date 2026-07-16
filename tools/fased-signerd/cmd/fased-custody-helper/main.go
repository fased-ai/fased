package main

import (
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"

	"fased-signerd/internal/custodyhelper"
)

func main() {
	var origins originList
	flag.Var(&origins, "gateway-origin", "exact trusted Gateway origin; repeat for multiple Gateways")
	flag.Parse()
	store := custodyhelper.NewPlatformStorage()
	handler, err := custodyhelper.NewHandlerWithOrigins(store, origins)
	if err != nil {
		log.Fatal(err)
	}
	address := fmt.Sprintf("%s:%d", custodyhelper.Host, custodyhelper.Port)
	server := &http.Server{
		Addr:              address,
		Handler:           handler,
		ReadHeaderTimeout: 5e9,
	}

	log.Printf(
		"wallet custody helper listening on http://%s (%s / %s)",
		address,
		store.Platform(),
		store.StorageMode(),
	)
	if warning := store.Warning(); warning != "" {
		log.Printf("wallet custody helper warning: %s", warning)
	}

	if len(origins) == 0 {
		log.Printf("wallet custody helper storage routes disabled: pass --gateway-origin for each exact trusted Gateway origin")
	}

	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

type originList []string

func (values *originList) String() string {
	return fmt.Sprintf("%v", []string(*values))
}

func (values *originList) Set(value string) error {
	*values = append(*values, value)
	return nil
}
