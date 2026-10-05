import sharp from "sharp";
import { check, checkDeep, checkMatch, summary } from "./helpers/check.mjs";
import {
	MAX_IMAGE_BYTES, MAX_IMAGES_PER_REQUEST, MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION_MANY,
	MANY_IMAGES_THRESHOLD, validateImageInputs, buildUserContent,
} from "../out/image_content.js";

const image = (data, mimeType = "image/png") => ({ kind: "image", mimeType, data });
const png = (width, height) => sharp({ create: { width, height, channels: 3, background: "white" } }).png().toBuffer();
const tiny = await png(1, 1);
const small = image(tiny);
const error = (fn) => {
	try {
		fn();
		return "";
	} catch (e) {
		return e.message;
	}
};

check("count ceiling", MAX_IMAGES_PER_REQUEST, 600);
check("normal dimension ceiling", MAX_IMAGE_DIMENSION, 8192);
check("many-image dimension ceiling", MAX_IMAGE_DIMENSION_MANY, 4096);
check("many-image threshold", MANY_IMAGES_THRESHOLD, 15);
checkDeep("no user images", validateImageInputs([{ kind: "text", text: "plain" }]), { count: 0, maxBytes: 0 });
checkDeep("counts accepted raw bytes", validateImageInputs([small]), { count: 1, maxBytes: tiny.length });

for (const format of ["jpeg", "png", "gif", "webp"]) {
	const data = await sharp({ create: { width: 3, height: 2, channels: 3, background: "white" } }).toFormat(format).toBuffer();
	const input = image(data, "IMAGE/JPG; charset=binary");
	check(`actual ${format} accepted despite JPEG declaration`, validateImageInputs([input]).count, 1);
	check(`actual ${format} controls sent MIME`, buildUserContent([input], true).content[0].image_url.url.startsWith(`data:image/${format};base64,`), true);
}
const unsupported = image(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10000" height="10000"></svg>'));
check("unsupported actual SVG dropped despite PNG declaration", buildUserContent([unsupported], true).droppedUnsupported, 1);
for (const mimeType of ["image/bmp", "image/avif", "application/octet-stream", ""]) {
	check(`actual PNG counted despite declaration ${mimeType}`, validateImageInputs([image(tiny, mimeType)]).count, 1);
}
checkDeep("unsupported actual inputs do not count", validateImageInputs([unsupported]), { count: 0, maxBytes: 0 });
checkMatch("corrupt image metadata actionable", error(() => validateImageInputs([image(Buffer.from("bad"))])), /format or dimensions.*corrupt or incomplete.*re-export/);
checkMatch("truncated supported PNG actionable", error(() => validateImageInputs([image(tiny.subarray(0, 8))])), /format or dimensions.*re-export/);

check("600 images accepted", validateImageInputs(Array(600).fill(small)).count, 600);
checkMatch("601 image error actionable", error(() => validateImageInputs(Array(601).fill(small))), /601 images.*at most 600.*Remove images/);
check("dropped images do not affect count ceiling", validateImageInputs([...Array(600).fill(small), unsupported]).count, 600);

const wide8192 = image(await png(8192, 1));
const tall8192 = image(await png(1, 8192));
check("8192 wide boundary accepted", validateImageInputs([wide8192]).count, 1);
check("8192 tall boundary accepted", validateImageInputs([tall8192]).count, 1);
for (const [width, height] of [[8193, 1], [1, 8193]]) {
	const input = image(await png(width, height));
	checkMatch(`${width}x${height} rejected with resize guidance`, error(() => validateImageInputs([input])), /8193.*at most 8192.*Resize/);
}
check("14 images retain 8192 limit", validateImageInputs([wide8192, ...Array(13).fill(small)]).count, 14);
check("unsupported 15th image does not tighten limit", validateImageInputs([wide8192, ...Array(13).fill(small), unsupported]).count, 14);
checkMatch("15 images tighten limit across full array", error(() => validateImageInputs([wide8192, ...Array(14).fill(small)])), /at most 4096.*15 images.*fewer than 15/);
for (const [width, height] of [[4096, 1], [1, 4096]]) {
	const input = image(await png(width, height));
	check(`${width}x${height} accepted at 15`, validateImageInputs([input, ...Array(14).fill(small)]).count, 15);
}
for (const [width, height] of [[4097, 1], [1, 4097]]) {
	const input = image(await png(width, height));
	checkMatch(`${width}x${height} rejected at 15`, error(() => validateImageInputs([...Array(14).fill(small), input])), /Image 15.*4097.*at most 4096/);
}

const atLimit = Buffer.alloc(MAX_IMAGE_BYTES);
tiny.copy(atLimit);
check("32 MiB RAW image accepted before base64", validateImageInputs([image(atLimit)]).maxBytes, MAX_IMAGE_BYTES);
const overLimit = Buffer.alloc(MAX_IMAGE_BYTES + 1);
tiny.copy(overLimit);
checkMatch("one byte above RAW limit actionable", error(() => validateImageInputs([image(overLimit)])), /32 MiB.*Compress or resize/);
checkMatch("builder refuses oversized inline image", error(() => buildUserContent([image(overLimit)], true)), /inline image limit/);
checkMatch("raw size checked before malformed metadata", error(() => validateImageInputs([image(new Uint8Array(MAX_IMAGE_BYTES + 1))])), /inline image limit/);
checkMatch("raw cap applies regardless of declared MIME", error(() => validateImageInputs([image(overLimit, "image/bmp")])), /inline image limit/);
check("non-vision builder drops oversized image without rejecting", buildUserContent([image(overLimit)], false).droppedNoVision, 1);

const frozen = Object.freeze([Object.freeze(small), Object.freeze({ kind: "text", text: "look" })]);
const before = Buffer.from(tiny);
validateImageInputs(frozen);
check("validation leaves bytes unchanged", tiny.equals(before), true);
summary("unit_image_limits");
