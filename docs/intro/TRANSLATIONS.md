# Translations are welcome

The intro lane launches in English, but its structure is ready for community translations when a contributor wants to maintain one. This keeps the original “prepared, not committed” decision intact: SMARCH does not promise a locale until people are ready to own its accuracy.

## Directory and file convention

Copy the complete English lesson set into `docs/intro/<locale>/`, using a lowercase BCP 47 language tag such as `de` or `th`. Keep every filename unchanged so lesson order, links, and journey coverage can be compared mechanically.

```text
docs/intro/de/START_HERE.md
docs/intro/de/00-orientation.md
docs/intro/de/01-what-is-a-brick.md
...
docs/intro/de/18-your-first-agent-swarm.md
```

Translate prose, headings, link labels, image alt text, notes, and explanations. Preserve the page's `docs-i18n` key and change only the locale-specific source metadata when the locale pipeline defines it.

## Do not translate commands or observed output

Keep command lines, flags, filenames, paths, environment-variable names, JSON keys, schema fields, and literal terminal output exactly as the English source shows them. Those strings are executable contracts, not prose. You may translate the explanation before and after a code block.

Do not bake translated labels into screenshots. Put locale-specific media in the page's declared `media/{locale}/...` slot, retain meaningful alt text in Markdown, and keep the English asset as the fallback until a reviewed replacement exists.

## Contribution checklist

- Copy every intro page, not a partial lesson subset.
- Keep heading levels and code-fence language tags unchanged.
- Preserve relative destinations; translate link labels, not paths.
- Run the documentation lint and the intro journey against the English executable source.
- Ask a fluent reviewer to check meaning, warmth, and technical vocabulary.
- State who will maintain the locale when English lessons change.

Translations should sound welcoming and direct. Prefer clear everyday language over literal word-for-word structure, while keeping terms such as `brick`, `manifest`, and `gate` consistent with [the glossary](../GLOSSARY.md).

<!-- docs-i18n: key=docs.intro.translations; source=en; media=../media/{locale}/intro-translations/ -->
