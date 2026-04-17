# ICD-10-CM 2026 Trie Explorer

A jQuery-powered, dark-themed single-page application for browsing, searching, and exploring the full **FY2026 ICD-10-CM** code set (98,186 codes) using a real trie data structure.

## Features

- **Trie Browser** — lazy-rendered hierarchical tree across all 22 ICD-10-CM chapters with chapter filter pills
- **Prefix Search** — trie-walk from any code prefix (e.g. `J45`, `M79`, `S52`)
- **Full-text Search** — multi-keyword search across all 98,186 code descriptions
- **Exact Code Lookup** — jump directly to any code
- **Code Detail Panel** — full metadata, hierarchy breadcrumb, subcodes list, trie-path visualizer, copy-to-clipboard
- **FY2026 Addenda** — all 591 changes (487 adds, 28 deletes, 76 revisions) with filterable tabs and live search
- **Chapter Statistics** — all 22 chapters with billable percentage bars; click to filter the trie browser
- **Keyboard shortcut** — press `/` to focus search instantly

## Data

| File | Description | Size |
|---|---|---|
| `trie.json` | Hierarchical trie (102,739 nodes) | 21 MB |
| `flat.json` | Flat search index (98,186 records) | 16 MB |
| `addenda.json` | FY2026 adds/deletes/revisions | 77 KB |
| `chapter_stats.json` | Per-chapter code counts | 3 KB |
| `stats.json` | Aggregate statistics | <1 KB |

Data sourced from CMS ICD-10-CM FY2026 files. **Not for clinical use.**

## Running locally

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```
