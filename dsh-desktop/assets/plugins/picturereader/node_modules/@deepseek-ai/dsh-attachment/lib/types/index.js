/** Durable attachment storage seam (`ctx.attachments`). @module @deepseek-ai/dsh-attachment */
import { Service } from '@deepseek-ai/cordis';
import { AttachmentError } from "./error.js";
export { AttachmentId } from "./brand.js";
export { AttachmentError, isImageAdmissionError } from "./error.js";
export { admitEncodedImages } from "./admission.js";
/** Immutable binary attachment service. Implementations validate bytes before publishing a reference. */
export class AttachmentStore extends Service {
    constructor(ctx) {
        super(ctx, 'attachments');
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
        if (inputs.length > maxImagesPerMessage) {
            throw new AttachmentError('Image batch exceeds the configured image-count limit.', 'TOO_MANY_IMAGES');
        }
        const totalBytes = inputs.reduce((sum, input) => sum + input.data.byteLength, 0);
        if (totalBytes > maxMessageImageBytes) {
            throw new AttachmentError('Image batch exceeds the configured aggregate image-byte limit.', 'IMAGES_TOO_LARGE');
        }
        for (const input of inputs) {
            if (!mediaTypes.includes(input.mediaType)) {
                throw new AttachmentError(`Image type ${input.mediaType} is not accepted by this deployment.`, 'UNSUPPORTED_IMAGE_TYPE');
            }
        }
        for (const input of inputs)
            await this.validateImage(input);
        const refs = [];
        for (const input of inputs)
            refs.push(await this.saveImage(input));
        return refs;
    }
}
export default AttachmentStore;
//# sourceMappingURL=index.js.map