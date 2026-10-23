# Checking a chart's type

Load when the surface shows a chart, graph or data plot and you judge it. The result is one `ux_review[]` item with `rule: "chart_type"`
(`ok`, `concern` or `not_applicable` with a reason; screenshot of the chart). It never closes the gate.

Optional aid: when `skills/ui-design/library/charts.csv` exists in the install, it lists data shapes with a best chart type, alternatives, and when
not to use each. Read the row for the data shape you see. Never require the file; without it, use the rules below.

## Questions

1. **What is the data shape?** Change over time, comparison of categories, part of a whole, relationship of two measures, distribution, ranking, flow, geography.
2. **Does the type fit the shape?**
   - Time axis: line or area. Bars suit few periods.
   - Categories by size: bars, sorted; horizontal when labels are long. A table when there are more than about 15.
   - Parts of a whole: a stacked bar or a few-slice pie or donut (up to 5 slices that sum to a whole); never a pie for unrelated values.
   - Two measures: scatter. Distribution: histogram or box plot.
   - Fewer than 4 points: a number or a small table beats a chart.
3. **Is it honest?** Bars start at zero; no 3D; no dual axes that invent a correlation; no truncated or unlabeled axes.
4. **Is it readable?** Direct labels or a legend, units, a title that says the point, series told apart by more than colour (shape, pattern, label), at most about 6 series.
5. **Is there a text fallback?** A data table or a one-line summary, and keyboard-reachable values when the chart is interactive.
6. **Real data?** A decorative or invented chart of grey bars in a product that has real numbers is a concern.

Write a `concern` as: the chart, the shape it shows, the type that fits better, why. Name the selector.
