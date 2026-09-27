import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Effect } from "effect";
import { readFile, stat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getPdfInfo, withPdfPath } from "./files.ts";

const execFileAsync = promisify(execFile);

const cleanPath = (input: string): string => input.startsWith("@") ? input.slice(1) : input;

function sourceFile(path: string, cwd: string) {
  const sourcePath = resolve(cwd, cleanPath(path));

  return Effect.tryPromise({
    try: async () => {
      const file = await stat(sourcePath);

      if (!file.isFile()) throw new Error(`Not a file: ${path}`);

      return sourcePath;
    },
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  });
}

export default function registerPdfExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pdf_info",
    label: "PDF Info",
    description: "Get metadata and page count from a local PDF or convert a supported document to PDF with Pandoc and Typst first.",
    promptSnippet: "Get PDF or converted document metadata and page count",
    parameters: Type.Object({ path: Type.String({ description: "Path to a local PDF or document file" }) }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await Effect.runPromise(sourceFile(params.path, ctx.cwd).pipe(
        Effect.flatMap((path) => withPdfPath(path, signal, (pdfPath, converted) =>
          getPdfInfo(pdfPath, signal).pipe(Effect.map((info) => ({ path, converted, ...info }))))),
      ));

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });

  pi.registerTool({
    name: "pdf_page_image",
    label: "PDF Page Image",
    description: "Render a page from a local PDF or convert a supported document to PDF with Pandoc and Typst first.",
    promptSnippet: "Read a PDF or converted document page as an image",
    promptGuidelines: [
      "Use pdf_page_image when the user asks to inspect visual contents, layout, figures, diagrams, or document pages.",
      "Use pdf_info first when the page count or metadata is unknown.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to a local PDF or document file" }),
      page: Type.Integer({ minimum: 1, description: "1-based page number" }),
      dpi: Type.Optional(Type.Integer({ minimum: 72, maximum: 300, description: "Render resolution; defaults to 144" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return await Effect.runPromise(sourceFile(params.path, ctx.cwd).pipe(
        Effect.flatMap((path) => withPdfPath(path, signal, (pdfPath, converted) => Effect.gen(function* () {
          const info = yield* getPdfInfo(pdfPath, signal);

          if (params.page > info.pages) return yield* Effect.fail(new Error(`Page ${params.page} is outside the document (1-${info.pages})`));
          const directory = yield* Effect.tryPromise({ try: () => mkdtemp(join(tmpdir(), "pi-pdf-page-")), catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)) });

          return yield* Effect.acquireUseRelease(
            Effect.succeed(directory),
            () => Effect.tryPromise({
              try: async () => {
                const dpi = params.dpi ?? 144;
                const outputBase = join(directory, "page");
                await execFileAsync("pdftoppm", ["-f", String(params.page), "-l", String(params.page), "-png", "-r", String(dpi), "-singlefile", pdfPath, outputBase], { signal, maxBuffer: 1024 * 1024 });
                const image = await readFile(`${outputBase}.png`);

                return {
                  content: [
                    { type: "text" as const, text: `Rendered ${basename(path)}, page ${params.page} of ${info.pages}${converted ? " (converted to PDF first)" : ""} at ${dpi} DPI.` },
                    { type: "image" as const, mimeType: "image/png" as const, data: image.toString("base64") },
                  ],
                  details: { path, converted, page: params.page, pages: info.pages, dpi, bytes: image.byteLength },
                };
              },
              catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
            }),
            (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
          );
        }))),
      ));
    },
  });
}
