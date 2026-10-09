package shop

import "testing"

func TestFormatPrice(t *testing.T) {
	if got := FormatPrice(1250); got != "12.50 USD" {
		t.Fatalf("FormatPrice(1250) = %q", got)
	}
}

func TestFormatPriceEuro(t *testing.T) {
	DefaultCurrency = "EUR"
	if got := FormatPrice(1250); got != "12.50 EUR" {
		t.Fatalf("FormatPrice(1250) = %q", got)
	}
}

func TestApplyDiscount(t *testing.T) {
	cases := []struct{ in, want int }{{9999, 9999}, {10000, 9000}, {20000, 18000}, {0, 0}}
	for _, c := range cases {
		if got := ApplyDiscount(c.in); got != c.want {
			t.Errorf("ApplyDiscount(%d) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestParseAmount(t *testing.T) {
	for in, want := range map[string]int{"12.50": 1250, "3": 300, " 0.05 ": 5} {
		got, err := ParseAmount(in)
		if err != nil || got != want {
			t.Errorf("ParseAmount(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	for _, in := range []string{"abc", "1.234", "-1", "1.x0", "1.5", ""} {
		if _, err := ParseAmount(in); err == nil {
			t.Errorf("ParseAmount(%q) succeeded, want error", in)
		}
	}
}
