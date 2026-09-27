import { Effect } from "effect";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PDF_ENGINE = "typst";

export type PdfInfo = {
  pages: number;
  title?: string;
  author?: string;
  creator?: string;
  producer?: string;
  pageSize?: string;
  fileSize?: string;
  pdfVersion?: string;
};

export function parsePdfInfo(output: string): PdfInfo {
  const fields = new Map<string, string>();

  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf(":");

    if (separator > 0) fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }

  const pages = Number(fields.get("Pages"));

  if (!Number.isInteger(pages) || pages < 1) throw new Error("pdfinfo did not return a valid page count");

  const info: PdfInfo = { pages };

  const optionalFields: Array<[string, keyof Omit<PdfInfo, "pages">]> = [
    ["Title", "title"], ["Author", "author"], ["Creator", "creator"], ["Producer", "producer"],
    ["Page size", "pageSize"], ["File size", "fileSize"], ["PDF version", "pdfVersion"],
  ];

  for (const [source, target] of optionalFields) {
    const value = fields.get(source);

    if (value && value !== "-") info[target] = value;
  }

  return info;
}

export function getPdfInfo(path: string, signal?: AbortSignal): Effect.Effect<PdfInfo, Error> {
  return Effect.tryPromise({
    try: async () => parsePdfInfo((await execFileAsync("pdfinfo", [path], { signal, maxBuffer: 1024 * 1024 })).stdout),
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  });
}

function convertDocumentToPdf(path: string, outputDirectory: string, signal?: AbortSignal): Effect.Effect<string, Error> {
  const outputPath = join(outputDirectory, `${basename(path, extname(path))}.pdf`);

  return Effect.tryPromise({
    try: async () => {
      await execFileAsync("pandoc", [path, "--output", outputPath, `--pdf-engine=${PDF_ENGINE}`], { signal, maxBuffer: 1024 * 1024 });
      const output = await stat(outputPath);

      if (!output.isFile()) throw new Error(`Pandoc completed without creating ${basename(outputPath)}`);

      return outputPath;
    },
    catch: (cause) => new Error(`Cannot convert ${basename(path)} to PDF with Pandoc and Typst: ${cause instanceof Error ? cause.message : String(cause)}. Install pandoc and typst.`, { cause }),
  });
}

export function withPdfPath<A, E>(
  sourcePath: string,
  signal: AbortSignal | undefined,
  action: (pdfPath: string, converted: boolean) => Effect.Effect<A, E>,
): Effect.Effect<A, Error | E> {
  if (extname(sourcePath).toLowerCase() === ".pdf") return action(sourcePath, false);

  return Effect.acquireUseRelease(
    Effect.tryPromise({ try: () => mkdtemp(join(tmpdir(), "pi-document-pdf-")), catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)) }),
    (directory) => convertDocumentToPdf(sourcePath, directory, signal).pipe(Effect.flatMap((path) => action(path, true))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })), 
  );
}
