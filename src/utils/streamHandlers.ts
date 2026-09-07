import { StreamData, StreamHandlerResult, StreamOP } from "@frejun/teler";
import { remoteWsURL } from "./wsServer";
import { WebSocket } from "ws";
import { AudioProcessor } from "./audioProcessor";
import { configMessage, greetingMessage } from "../core/geminiConfig";

const sendToGemini = (message: object) => {
    if (remoteWsURL.readyState === WebSocket.OPEN) {
        remoteWsURL.send(JSON.stringify(message));
    }
};

export const callStreamHandler = () =>{
    let isConfSent = false;

    const handler = async (message: StreamData): Promise<StreamHandlerResult> => {
        try {
            if (typeof message === "string") {
                const data = JSON.parse(message);
                if(remoteWsURL.readyState === WebSocket.OPEN && data["type"] === "audio") {
                    const wsPayload = {
                        realtimeInput: {
                            audio: {
                                data: data["data"]["audio_b64"],
                                mimeType: 'audio/pcm;rate=16000'
                            }
                        }
                    };
                    const payload = JSON.stringify(wsPayload);
                    return [payload, StreamOP.RELAY];
                } else if(!isConfSent) {
                    console.log('Configuration sent');
                    isConfSent = true;
                    return [configMessage, StreamOP.RELAY];
                }
            }
            return ['', StreamOP.PASS];
        } catch(err) {
            console.log("Error in call stream handler", err);
            return ['', StreamOP.PASS];
        }
    }
    return handler;
}     

export const remoteStreamHandler = () => {
    let chunk_id = 1
    const messageBuffer: Buffer[] = [];
    const audioProcessor = new AudioProcessor();

    function _flush_buffer() {
        const audioData = Buffer.concat(messageBuffer);
        const resampledAudio = audioProcessor.downsample(audioData);

        const payload = JSON.stringify({
            "type": "audio",
            "audio_b64": resampledAudio.toString('base64'),
            "chunk_id": chunk_id++,
        });
        messageBuffer.length = 0;
        return payload;
    }

    const handler = async(data: StreamData): Promise<StreamHandlerResult> => {
        try {
            const message = data.toString('utf-8');
            if (typeof message === "string") {
                const data = JSON.parse(message);
                if (data?.setupComplete) {
                    console.log("Gemini configuration set");
                    // send user greeting message
                    sendToGemini(greetingMessage);
                } if (data?.serverContent) {
                    const serverContent = data.serverContent;

                    if (serverContent?.modelTurn?.parts) {    
                        for (const part of serverContent.modelTurn.parts) {
                            if (part.inlineData) {
                                const audioData = part.inlineData.data;
                                messageBuffer.push(Buffer.from(audioData, 'base64'));
                            }
                        }
    
                        if (messageBuffer.length >= 10) {
                            return [_flush_buffer(), StreamOP.RELAY];
                        }
                    } else if (serverContent?.interrupted) {
                        console.debug("Interrupted, clear buffer..");
                        messageBuffer.length = 0;
                        const payload = JSON.stringify({"type": "clear"});
                        return [payload, StreamOP.RELAY];
                    } else if (serverContent?.generationComplete || serverContent?.turnComplete) {
                        console.debug("Agent generation completed..");
                        return [_flush_buffer(), StreamOP.RELAY];
                    }
                }
            } 
            return ['', StreamOP.PASS];
        } catch (err) {
            console.log("Error in remote stream handler", err);
            return ['', StreamOP.PASS];
        }
    }

    return handler;
}