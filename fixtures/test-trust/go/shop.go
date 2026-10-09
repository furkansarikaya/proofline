// Package shop is a tiny checkout library.
package shop

import (
	"errors"
	"fmt"
	"math/rand/v2"
	"strconv"
	"strings"
	"time"
)

// DefaultCurrency is used when formatting prices.
var DefaultCurrency = "USD"

// FormatPrice renders cents as "12.50 USD".
func FormatPrice(cents int) string {
	return fmt.Sprintf("%d.%02d %s", cents/100, cents%100, DefaultCurrency)
}

// ApplyDiscount takes 10% off orders of 100.00 or more.
func ApplyDiscount(cents int) int {
	if cents >= 10000 {
		return cents * 90 / 100
	}
	return cents
}

// ParseAmount parses "12.50" or "3" into cents.
func ParseAmount(s string) (int, error) {
	whole, frac, hasFrac := strings.Cut(strings.TrimSpace(s), ".")
	w, err := strconv.Atoi(whole)
	if err != nil || w < 0 {
		return 0, errors.New("invalid amount")
	}
	if !hasFrac {
		return w * 100, nil
	}
	if len(frac) != 2 {
		return 0, errors.New("invalid amount")
	}
	f, err := strconv.Atoi(frac)
	if err != nil {
		return 0, errors.New("invalid amount")
	}
	return w*100 + f, nil
}

// Backoff returns the wait before retry number attempt, with jitter.
func Backoff(attempt int) time.Duration {
	base := 100 * time.Millisecond << attempt
	return base + rand.N(base)
}

// NormalizeEmail lowercases and trims an email address.
func NormalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// Reconcile returns how much was charged but not settled.
func Reconcile(charged, settled []int) int {
	diff := 0
	for _, c := range charged {
		diff += c
	}
	for _, s := range settled {
		diff -= s
	}
	return diff
}

type Order struct {
	Email string
	Items []int
	Total int
}

type Store interface{ Save(Order) error }
type Mailer interface{ Send(to, body string) error }

// Checkout totals the order, saves it, and emails a receipt.
func Checkout(store Store, mailer Mailer, o Order) (Order, error) {
	total := 0
	for _, item := range o.Items {
		total += item
	}
	o.Total = ApplyDiscount(total)
	o.Email = NormalizeEmail(o.Email)
	if err := store.Save(o); err != nil {
		return Order{}, err
	}
	if err := mailer.Send(o.Email, "Total: "+FormatPrice(o.Total)); err != nil {
		return Order{}, err
	}
	return o, nil
}
