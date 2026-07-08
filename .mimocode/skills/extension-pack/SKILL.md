---
name: simadesk:extension-pack
description: "Package the SimaDesk Chrome extension into a zip for distribution. Rebuild the zip from the extension/ directory."
---

# Package Chrome Extension

Rebuild the extension zip artifact from `extension/`.

## Command

```bash
cd "/Users/samarzi/Desktop/SIMA OS/SIMA-samarzi/Projects/SimaDesk" && \
rm -f simadesk-extension.zip && \
cd extension && \
zip -r ../simadesk-extension.zip . --exclude "*.DS_Store" && \
echo "✅ Extension packed: simadesk-extension.zip"
```

## Output

- Creates `simadesk-extension.zip` in the project root.
- Excludes `.DS_Store` files.
- Overwrites any previous zip.

## When to use

- After modifying anything under `extension/` (background.js, content scripts, manifest).
- Before uploading to Chrome Web Store or distributing to users.
- The extension connects to SimaDesk backend via the Chrome Preview MCP server.
