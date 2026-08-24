import { Service } from "@deepseek-ai/cordis";
import { Buffer } from "node:buffer";
//#region lib/types/error.js
/** Runtime membership for structurally compatible errors crossing package boundaries. */
const IMAGE_ADMISSION_ERROR_CODE_SET = new Set([
	"TOO_MANY_IMAGES",
	"IMAGES_TOO_LARGE",
	"UNSUPPORTED_IMAGE_TYPE",
	"INVALID_IMAGE_BASE64",
	"INVALID_IMAGE",
	"IMAGE_TYPE_MISMATCH",
	"IMAGE_TOO_LARGE",
	"IMAGE_TOO_MANY_PIXELS",
	"IMAGE_DIMENSION_TOO_LARGE"
]);
/**
* Stable failures suitable for host RPC error mapping.
*
* Deliberately re-implements the `HarnessError` shape instead of extending it:
* the base lives in `@deepseek-ai/dsh-llm`, which itself depends on this
* package (`ImageBlock` references `ImageAttachmentRef`), so sharing the base
* would create a dependency cycle. Consumers route on `code`, never on the
* prototype chain, so the shapes stay interchangeable at the wire boundary.
*/
var AttachmentError = class extends Error {
	/** Stable machine-routing failure code. */
	code;
	/**
	* @param message - human-readable failure description without raw bytes or host paths.
	* @param code - stable machine-routing code.
	* @param options - optional chained cause.
	*/
	constructor(message, code, options) {
		super(message, options);
		this.name = "AttachmentError";
		this.code = code;
	}
};
/**
* Distinguish caller-correctable image admission failures from storage faults.
* @param error - failure raised while validating or persisting an image batch.
* @returns whether the caller can correct the proposed image content or batch.
*/
function isImageAdmissionError(error) {
	return error instanceof Error && "code" in error && typeof error.code === "string" && IMAGE_ADMISSION_ERROR_CODE_SET.has(error.code);
}
//#endregion
//#region lib/types/brand.js
/** Attachment identifier brand. @module @deepseek-ai/dsh-attachment/brand */
/**
* Brand a validated storage identifier.
* @param value - backend-produced opaque identifier.
* @returns the branded identifier.
*/
function AttachmentId(value) {
	return value;
}
//#endregion
//#region lib/types/admission.js
/** Wire-form admission of base64-encoded image uploads. @module @deepseek-ai/dsh-attachment/admission */
/** Decode one upload payload while rejecting non-canonical base64 forms. */
function decodeBase64(data) {
	const decoded = Buffer.from(data, "base64");
	if (data.length === 0 || decoded.toString("base64") !== data) throw new AttachmentError("Image upload is not canonical base64.", "INVALID_IMAGE_BASE64");
	return new Uint8Array(decoded);
}
/** Store input for one decoded upload. */
function saveInput(image) {
	return {
		data: decodeBase64(image.data),
		mediaType: image.mediaType,
		...image.name === void 0 ? {} : { name: image.name }
	};
}
/**
* Admit one wire image batch: enforce canonical base64 on every member, then
* delegate batch admission — count and aggregate-byte limits, media-type and
* per-image validation, ordered commit — to {@link AttachmentStore.saveImages}.
* The shared entry for every RPC endpoint accepting browser uploads.
* @param attachments - the deployment attachment store owning batch policy.
* @param images - base64-encoded uploads in caller order.
* @returns durable references in the same order as `images`.
* @throws AttachmentError on a non-canonical payload or a refused batch.
*/
async function admitEncodedImages(attachments, images) {
	return attachments.saveImages(images.map(saveInput));
}
//#endregion
//#region lib/types/index.js
/** Durable attachment storage seam (`ctx.attachments`). @module @deepseek-ai/dsh-attachment */
/** Immutable binary attachment service. Implementations validate bytes before publishing a reference. */
var AttachmentStore = class extends Service {
	constructor(ctx) {
		super(ctx, "attachments");
	}
	/**
	* Validate one ordered image batch before committing any member.
	* Validation failures start no writes; storage failures return no partial
	* references, although already published content-addressed objects may stay
	* unreachable until a future retention policy collects them.
	* @param inputs - encoded images in their owning message order.
	* @returns durable references in the exact input order.
	*/
	async saveImages(inputs) {
		const { maxImagesPerMessage, maxMessageImageBytes, mediaTypes } = this.imageLimits;
		if (inputs.length > maxImagesPerMessage) throw new AttachmentError("Image batch exceeds the configured image-count limit.", "TOO_MANY_IMAGES");
		if (inputs.reduce((sum, input) => sum + input.data.byteLength, 0) > maxMessageImageBytes) throw new AttachmentError("Image batch exceeds the configured aggregate image-byte limit.", "IMAGES_TOO_LARGE");
		for (const input of inputs) if (!mediaTypes.includes(input.mediaType)) throw new AttachmentError(`Image type ${input.mediaType} is not accepted by this deployment.`, "UNSUPPORTED_IMAGE_TYPE");
		for (const input of inputs) await this.validateImage(input);
		const refs = [];
		for (const input of inputs) refs.push(await this.saveImage(input));
		return refs;
	}
};
//#endregion
export { AttachmentError, AttachmentId, AttachmentStore, AttachmentStore as default, admitEncodedImages, isImageAdmissionError };
