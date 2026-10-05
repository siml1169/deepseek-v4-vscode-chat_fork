/**
 * Pure (vscode-free) assembly of multimodal user-message content for the
 * DeepSeek Flash API (deepseek-flash).
 *
 * The Vision endpoint keeps the OpenAI-compatible /chat/completions shape but
 * switches `content` from a plain string to an array of typed blocks:
 *   { type: "text", text: "..." }
 *   { type: "image_url", image_url: { url: "data:image/png;base64,..." } }
 *
 * Extracted from convertMessages in utils.ts — which remains the thin vscode
 * adapter (LanguageModelDataPart → ImagePartInput) — so the block assembly,
 * format gating, and drop accounting are importable by the Node unit harness
 * (test/unit_image_content.mjs) without a vscode mock. Same vscode-free
 * extraction pattern as tool_names.ts / tool_payload.ts / tool_limit.ts.
 */

import { imageSize } from "image-size";
import type { ImageDetail, OpenAIContentPart } from "./types";

/**
 * Image formats the Vision API accepts. DeepSeek sniffs the real format from
 * the file bytes, not the declared MIME or filename. Unsupported actual
 * containers are dropped rather than risking a server-side request failure.
 */
export const SUPPORTED_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
]);

/**
 * DeepSeek bills each image at up to 1024 tokens. We use the ceiling as the
 * local estimate: the pre-flight overflow check must never under-count, and
 * at 1024 tokens/image the overshoot is small against a 1M window.
 */
export const IMAGE_TOKENS_PER_IMAGE = 1024;

/**
 * The Vision API caps the request body at 48 MiB — base64-encoded image
 * bytes count toward it. Checked against the UTF-8 serialized JSON body
 * right before fetch.
 */
export const MAX_REQUEST_BODY_BYTES = 48 * 1024 * 1024;

/**
 * DeepSeek caps a single inline (base64 / URL) image at 32 MiB — separate
 * from the 48 MiB body cap; Files API uploads get 64 MiB, which we don't use.
 * Compared against the raw attachment bytes, before base64 encoding.
 */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGES_PER_REQUEST = 600;
export const MAX_IMAGE_DIMENSION = 8192;
export const MAX_IMAGE_DIMENSION_MANY = 4096;
export const MANY_IMAGES_THRESHOLD = 15;

/** Ordered content inputs harvested from one VS Code chat message. */
export type UserContentInput =
	| { kind: "text"; text: string }
	| { kind: "image"; mimeType: string; data: Uint8Array; detail?: ImageDetail };

/**
 * Result of assembling one message's content. `content` is a plain string
 * whenever no image survived — the wire shape for text-only messages must
 * stay identical to the pre-vision extension so server prompt-cache prefixes
 * (and the reasoning-cache fingerprints derived from them) are unchanged.
 */
export interface BuiltUserContent {
	content: string | OpenAIContentPart[];
	/** Images dropped because the selected model variant has no image input. */
	droppedNoVision: number;
	/** Images dropped because their actual format is unsupported. */
	droppedUnsupported: number;
}

/**
 * Lower-case the MIME, strip parameters (`image/png; charset=x` → `image/png`),
 * and fold the common `image/jpg` misnomer into `image/jpeg`.
 */
export function normalizeImageMime(mimeType: string): string {
	const bare = mimeType.split(";")[0].trim().toLowerCase();
	return bare === "image/jpg" ? "image/jpeg" : bare;
}

/** Whether the declared MIME type is accepted by the Vision API. */
export function isSupportedImageMime(mimeType: string): boolean {
	return SUPPORTED_IMAGE_MIME_TYPES.has(normalizeImageMime(mimeType));
}

/** Invalid or omitted detail keeps the API's default original behavior. */
export function coerceImageDetail(raw: unknown): ImageDetail | undefined {
	return raw === "low" || raw === "high" || raw === "original" || raw === "auto" ? raw : undefined;
}

function supportedImageMetadata(input: Extract<UserContentInput, { kind: "image" }>) {
	try {
		const metadata = imageSize(input.data);
		const mimeType = metadata.type === "jpg" ? "image/jpeg" : `image/${metadata.type}`;
		if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
			return undefined;
		}
		if (!(metadata.width > 0 && metadata.height > 0)) {
			throw new Error("Invalid image dimensions");
		}
		return { mimeType, width: metadata.width, height: metadata.height };
	} catch {
		throw new Error("Cannot read this image's format or dimensions. The image may be corrupt or incomplete; re-export it as JPEG, PNG, GIF, or WebP before sending.");
	}
}

/** Inspect actual bytes; corrupt metadata throws rather than bypassing validation. */
export function isSupportedImageData(data: Uint8Array): boolean {
	return supportedImageMetadata({ kind: "image", mimeType: "", data }) !== undefined;
}

/**
 * Validate the combined USER inputs actually sent in one request, not merely
 * the latest attachment list. Unsupported images are dropped by the builder
 * and must not tighten the count-dependent dimension limit.
 */
export function validateImageInputs(inputs: readonly UserContentInput[]): { count: number; maxBytes: number } {
	const images = [];
	let maxBytes = 0;
	for (const input of inputs) {
		if (input.kind !== "image") {
			continue;
		}
		if (input.data.byteLength > MAX_IMAGE_BYTES) {
			throw new Error(`Image ${images.length + 1} is ${(input.data.byteLength / (1024 * 1024)).toFixed(1)} MiB; the inline image limit is 32 MiB. Compress or resize the image before sending.`);
		}
		const metadata = supportedImageMetadata(input);
		if (!metadata) {
			continue;
		}
		maxBytes = Math.max(maxBytes, input.data.byteLength);
		images.push(metadata);
	}
	if (images.length > MAX_IMAGES_PER_REQUEST) {
		throw new Error(`This request contains ${images.length} images; DeepSeek accepts at most 600 images per request. Remove images or start a new conversation.`);
	}
	const dimensionLimit = images.length >= MANY_IMAGES_THRESHOLD ? MAX_IMAGE_DIMENSION_MANY : MAX_IMAGE_DIMENSION;
	for (const [index, image] of images.entries()) {
		if (image.width > dimensionLimit || image.height > dimensionLimit) {
			throw new Error(`Image ${index + 1} is ${image.width}×${image.height}; each side must be at most ${dimensionLimit} pixels for a request with ${images.length} images. Resize the image${dimensionLimit === MAX_IMAGE_DIMENSION_MANY ? " or reduce the request to fewer than 15 images" : ""}.`);
		}
	}
	return { count: images.length, maxBytes };
}

/** Encode raw image bytes as a `data:` URL for an image_url block. */
export function imageDataUrl(mimeType: string, data: Uint8Array): string {
	return `data:${normalizeImageMime(mimeType)};base64,${Buffer.from(data).toString("base64")}`;
}

/**
 * Assemble one message's ordered inputs into wire content.
 *
 * Adjacent text inputs are merged into a single text block so the block
 * count reflects real modality boundaries, not how the host happened to
 * chunk its text parts. When `imageInput` is false every image is dropped
 * (counted, for the caller to log) and the result degrades to the plain
 * string the non-vision variants have always sent.
 */
export function buildUserContent(inputs: readonly UserContentInput[], imageInput: boolean): BuiltUserContent {
	if (imageInput) {
		validateImageInputs(inputs);
	}
	const blocks: OpenAIContentPart[] = [];
	let droppedNoVision = 0;
	let droppedUnsupported = 0;

	for (const input of inputs) {
		if (input.kind === "text") {
			const last = blocks[blocks.length - 1];
			if (last && last.type === "text") {
				last.text += input.text;
			} else {
				blocks.push({ type: "text", text: input.text });
			}
			continue;
		}
		if (!imageInput) {
			droppedNoVision++;
			continue;
		}
		const metadata = supportedImageMetadata(input);
		if (!metadata) {
			droppedUnsupported++;
			continue;
		}
		const imageUrl: { url: string; detail?: ImageDetail } = { url: imageDataUrl(metadata.mimeType, input.data) };
		const detail = coerceImageDetail(input.detail);
		if (detail !== undefined) {
			imageUrl.detail = detail;
		}
		blocks.push({ type: "image_url", image_url: imageUrl });
	}

	const hasImage = blocks.some((b) => b.type === "image_url");
	if (!hasImage) {
		// Text-only after drops — collapse to the legacy string shape.
		const text = blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
		return { content: text, droppedNoVision, droppedUnsupported };
	}
	return { content: blocks, droppedNoVision, droppedUnsupported };
}

/**
 * Concatenated text of a wire content value, whatever its shape. Used by the
 * reasoning-cache fingerprint and log paths that need "the text of this
 * message" without caring about modality.
 */
export function contentText(content: string | OpenAIContentPart[] | undefined): string {
	if (content === undefined) {
		return "";
	}
	if (typeof content === "string") {
		return content;
	}
	let text = "";
	for (const block of content) {
		if (block.type === "text") {
			text += block.text;
		}
	}
	return text;
}
