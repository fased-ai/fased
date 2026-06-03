package main

import (
	"errors"
	"fmt"
	"log"
	"net/http"

	"fased-signerd/internal/custodyhelper"
)

func main() {
	store := custodyhelper.NewPlatformStorage()
	address := fmt.Sprintf("%s:%d", custodyhelper.Host, custodyhelper.Port)
	server := &http.Server{
		Addr:              address,
		Handler:           custodyhelper.NewHandler(store),
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

	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
