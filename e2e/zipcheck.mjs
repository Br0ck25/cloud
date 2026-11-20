// Opens a ZIP with Python's own zip reader (an independent implementation) and reports what is inside. testzip() also checks every file's CRC.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function inspectZip(bytes) {
  const dir = mkdtempSync(join(tmpdir(), "zip-"));
  try {
    writeFileSync(join(dir, "a.zip"), bytes);
    const script = "import sys,json,zipfile,hashlib\nz=zipfile.ZipFile(sys.argv[1])\nprint(json.dumps({'bad':z.testzip(),'names':z.namelist(),'sha':{i.filename:hashlib.sha256(z.read(i)).hexdigest() for i in z.infolist() if not i.is_dir()},'dirs':[i.filename for i in z.infolist() if i.is_dir()]}))";
    return JSON.parse(execFileSync("python3", ["-c", script, join(dir, "a.zip")]).toString());
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
