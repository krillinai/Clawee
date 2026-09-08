package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/krillinai/Clawee/server/internal/office/collectorapi"
)

func writeError(w http.ResponseWriter, status int, code string, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(collectorapi.ErrorResponse{
		Error: collectorapi.ErrorBody{
			Code:    code,
			Message: message,
		},
	})
}

func writeAccepted(w http.ResponseWriter, resp collectorapi.AcceptedResponse) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(resp)
}

func writeCreated(w http.ResponseWriter, resp any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(resp)
}
