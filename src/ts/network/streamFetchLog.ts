/**
 * Passes a byte stream through unchanged and hands its text to onFinalize once
 * the stream ends, fails or is cancelled. Unlike tee(), it only reads when the
 * consumer does, so it does not drain the source ahead of the consumer.
 */
export function pipeStreamWithTextLog(
    readableStream: ReadableStream<Uint8Array>,
    onFinalize: (responseText: string) => void,
): ReadableStream<Uint8Array> {
    const reader = readableStream.getReader()
    const decoder = new TextDecoder()
    let responseText = ''
    let finalized = false

    const finalize = () => {
        if (finalized) {
            return
        }
        finalized = true
        responseText += decoder.decode()
        onFinalize(responseText)
    }

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            let result: ReadableStreamReadResult<Uint8Array>
            try {
                result = await reader.read()
            } catch (error) {
                finalize()
                controller.error(error)
                return
            }
            if (result.done) {
                finalize()
                controller.close()
                return
            }
            responseText += decoder.decode(result.value, { stream: true })
            controller.enqueue(result.value)
        },
        async cancel(reason) {
            finalize()
            await reader.cancel(reason)
        },
    }, { highWaterMark: 0 })
}
