package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestTrainingRoutesAreAuthenticatedAndProxyRemovesCredentials(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/jobs" {
			t.Errorf("unexpected training proxy path %q", r.URL.Path)
		}
		for _, name := range []string{"Authorization", "X-DeepSeek-Key", "Cookie", "Proxy-Authorization"} {
			if r.Header.Get(name) != "" {
				t.Errorf("credential forwarded to training service: %s", name)
			}
		}
		_, _ = io.ReadAll(r.Body)
		writeJSON(w, 200, map[string]any{"job": "test-job", "training_verified": false})
	}))
	defer upstream.Close()
	a := &App{cfg: &Config{TrainingURL: upstream.URL}, guard: testGuard(t)}
	h := a.routes()
	r := httptest.NewRecorder()
	h.ServeHTTP(r, httptest.NewRequest("POST", "/api/training/jobs", strings.NewReader("x")))
	if r.Code != http.StatusUnauthorized || calls.Load() != 0 {
		t.Fatalf("anonymous training request was not rejected: %d calls=%d", r.Code, calls.Load())
	}
	req := authed("POST", "/api/training/jobs", "small")
	req.Header.Set("X-DeepSeek-Key", "private-key")
	req.Header.Set("Cookie", "private-cookie")
	req.Header.Set("Proxy-Authorization", "private-proxy")
	r = httptest.NewRecorder()
	h.ServeHTTP(r, req)
	if r.Code != http.StatusOK || calls.Load() != 1 {
		t.Fatalf("training proxy status=%d calls=%d body=%s", r.Code, calls.Load(), r.Body.String())
	}
}

func TestSimpleTrainingUploadUsesUploadBudget(t *testing.T) {
	g := testGuard(t)
	g.limits.JSONBytes = 8
	g.limits.UploadBytes = 16
	h := g.middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.ReadAll(r.Body); err != nil {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "bounded"})
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	for _, tc := range []struct {
		path string
		size int
		want int
	}{
		{"/api/training/jobs", 16, http.StatusNoContent},
		{"/api/training/jobs", 17, http.StatusRequestEntityTooLarge},
		{"/api/training/jobs/", 16, http.StatusRequestEntityTooLarge},
	} {
		req := authed("POST", tc.path, strings.Repeat("x", tc.size))
		req.ContentLength = -1
		recorder := httptest.NewRecorder()
		h.ServeHTTP(recorder, req)
		if recorder.Code != tc.want {
			t.Fatalf("%s size=%d want=%d got=%d", tc.path, tc.size, tc.want, recorder.Code)
		}
	}
}
