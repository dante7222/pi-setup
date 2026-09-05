# Focused HTML visuals

Use one file for the user's current point, not a dashboard of everything you know.

1. Use a safe, descriptive filename such as `show-me-session-flow.html` in the project's usual artifact location, or a temporary directory if none exists. Avoid overwriting an existing file. Report its absolute path.
2. Start from [the template](../assets/visual.html) when useful. Replace its sample title, labels, and content; don't leave generic filler. Match known product colors, type, and spacing. Otherwise keep the restrained neutral defaults. One accent color, clear headings, generous spacing, and real labels beat ornamental effects.
3. Prefer semantic HTML and CSS grid/flex with normal document flow. Stack at narrow widths. Use ordered lists for sequence and explicit condition labels for branches. Cards imply grouping, not necessarily order. Don't use fixed-position connectors that detach when labels wrap; prefer labeled steps, or SVG with a viewBox and a text equivalent when actual graph geometry matters.
4. Make the file self-contained: inline CSS, system fonts, no CDN, remote fonts, tracking, or runtime dependencies by default. Usually no JavaScript is needed. Escape untrusted labels as text; never insert raw user content into scripts or HTML. Use representative non-sensitive data; don't embed credentials or private payloads.
5. Include a document title, viewport meta tag, semantic headings, readable contrast (at least 4.5:1 for normal text), and visible text labels rather than color alone. Use actual buttons/links for interactions, with visible keyboard focus. Avoid animation unless it explains the topic and respects reduced motion.
6. Check the written file. If browser tools are available, render at a narrow viewport (320–375 px) and desktop (1280 px), inspect screenshots, and check for overflow, clipped text, detached connectors, and unreadable labels. Check wrapping at increased text size. Fix issues before presenting. If browser inspection is unavailable, say so briefly; don't claim it was visually verified.
7. Open the file with an available platform tool after writing it. On macOS use `open "/absolute/path/show-me-session-flow.html"`; on Linux use `xdg-open` if available. Quote the path. If opening is unavailable or fails, give the path/link instead and say it wasn't opened. An opener succeeding does not prove the page rendered correctly.

Keep the final response to the artifact link/path and the key takeaway. Include a compact terminal summary when the browser may be inaccessible.
