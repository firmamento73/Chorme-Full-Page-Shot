"""Package runtime files only; no test bridges or host permissions."""
from pathlib import Path
import json,zipfile
root=Path(__file__).resolve().parents[1]
manifest=json.loads((root/'manifest.json').read_text())
assert 'host_permissions' not in manifest and 'optional_host_permissions' not in manifest
for icons in [manifest['icons'],manifest['action']['default_icon']]:
 for size,name in icons.items():
  data=(root/name).read_bytes()
  assert data[:8]==b'\x89PNG\r\n\x1a\n'
  assert int.from_bytes(data[16:20],'big')==int(size) and int.from_bytes(data[20:24],'big')==int(size)
files=['manifest.json','background.js','classic.js','collector.js','overlays.js','core.js','seams.js','db.js','popup.html','popup.js','review.html','review.js','export.js','png-stream.js','ui.css','vendor/pdf-lib.min.js','vendor/pdf-lib-LICENSE.md','README.md','README.en.md','CHANGELOG.md','测试记录.md','LICENSE']
files += [str(path.relative_to(root)) for path in sorted((root/'icons').glob('*.png'))]
output=root/'dist'/f'fullpage-shot-{manifest["version"]}.zip';output.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as archive:
 for name in files:archive.write(root/name,'fullpage-shot/'+name)
with zipfile.ZipFile(output) as archive:
 for name in archive.namelist():assert '/tests/' not in name and '/.git/' not in name
 assert archive.testzip() is None
print(output)
