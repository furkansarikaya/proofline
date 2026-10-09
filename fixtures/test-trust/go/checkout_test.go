package shop

import (
	"testing"
	"time"
)

type fakeStore struct{}

func (fakeStore) Save(Order) error { return nil }

type fakeMailer struct{}

func (fakeMailer) Send(string, string) error { return nil }

func TestCheckout(t *testing.T) {
	_, err := Checkout(fakeStore{}, fakeMailer{}, Order{Email: "a@b.com", Items: []int{5000, 7000}})
	if err != nil {
		t.Fatal(err)
	}
}

func TestNormalizeEmail(t *testing.T) {
	NormalizeEmail("  Jane.Doe@Example.COM ")
}

func TestBackoff(t *testing.T) {
	if d := Backoff(1); d >= 300*time.Millisecond {
		t.Fatalf("Backoff(1) = %v, want under 300ms", d)
	}
}

func TestReconcile(t *testing.T) {
	time.Sleep(time.Second) // settlement provider is polled once per second
	if got := Reconcile([]int{500, 500}, []int{300}); got != 700 {
		t.Fatalf("Reconcile = %d, want 700", got)
	}
	if got := Reconcile(nil, []int{200}); got != -200 {
		t.Fatalf("Reconcile = %d, want -200", got)
	}
}
