// --- START OF FILE main.ts ---

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { serveDir } from "https://deno.land/std@0.224.0/http/file_server.ts";
import { load } from "https://deno.land/std/dotenv/mod.ts";

// --- 辅助函数：创建 JSON 错误响应 ---
function createJsonErrorResponse(message: string, statusCode = 500) {
    return new Response(JSON.stringify({ error: message }), {
        status: statusCode,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
}

// --- 辅助函数：休眠/等待 ---
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// =======================================================
// 模块 1: OpenRouter API 调用逻辑 (用于 nano banana)
// =======================================================
async function callOpenRouter(modelName: string, messages: any[], apiKey: string, imgWHRatio: string, imgSize: string): Promise<{ type: 'image' | 'text'; content: string }> {
    if (!apiKey) { throw new Error("callOpenRouter received an empty apiKey."); }
    
    const pmodelName = (!modelName || modelName.trim() === "") ? "gemini-3-pro-image-preview" : modelName;
    //const openrouterPayload = { model: pmodelName, messages };
    //console.log("Sending payload to OpenRouter:", JSON.stringify(openrouterPayload, null, 2));
    let payload: {
        contents: Array<{
            parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }>
        }>,
        generationConfig: {
            imageConfig: { aspectRatio?: string; imageSize?: string; }
        }
    } = {
        contents: [{
            parts: []
        }],
        generationConfig: {
            imageConfig: {
                aspectRatio: imgWHRatio,
                imageSize: ("gemini-2.5-flash-image"===modelName) ? "" : imgSize
            }
        }
    };

    //添加提示词或者图片
    const regex: RegExp = new RegExp("data:.+base64,", "gi");
    for (let i=0; i<messages.length; i++) {
        if (messages[i].type==="prompt") {
            payload.contents[0].parts.push({
                text: messages[i].message
            });
        } else if (messages[i].type==="image_url") {
            let imgBase64Data=messages[i].message;
            //需要去掉前缀
            imgBase64Data=imgBase64Data.replace(regex, "");
            payload.contents[0].parts.push({
                inline_data: {
                    mime_type: messages[i].mimeType,
                    data: imgBase64Data
                }
            });
        }
    }

    // 记录请求参数，add by sujialin at 20260228.
    let requestLogMsg=generateLogTimestamp();
    let reqparams=JSON.stringify(payload);
    const isdev=await isDevEnv();
    if (isdev) {
        requestLogMsg+=reqparams+"\r\n";
        await Deno.writeTextFile("./nano-banana-response.log", requestLogMsg, {
            append: true
        });
    }
    const apiResponse = await fetchWithTimeout(`https://cdn.12ai.org/v1beta/models/${pmodelName}:generateContent?key=${apiKey}`, {
        method: "POST", 
        headers: { "Content-Type": "application/json" },
        body: reqparams
    }, 300000);

    // 记录请求结果，add by sujialin at 20260228.
    let responseLogMsg=generateLogTimestamp();
    if (!apiResponse.ok) {
        const errorBody = await apiResponse.text();
        const errmsg=`OpenRouter API error: ${apiResponse.status} ${apiResponse.statusText} - ${errorBody}`;
        // 记录响应失败结果，add by sujialin at 20260228.
        if (isdev) {
            responseLogMsg+=errmsg+"\r\n";
            await Deno.writeTextFile("./nano-banana-response.log", responseLogMsg, {
                append: true
            });
        }
        throw new Error(errmsg);
    }
    const responseData = await apiResponse.json();
    // 记录响应成功结果，add by sujialin at 20260228.
    const successmg=`responseStatus: ${apiResponse.status}, responseStatusText: ${apiResponse.statusText}, content: ${JSON.stringify(responseData)}`;
    if (isdev) {
        responseLogMsg+=successmg+"\r\n";
        await Deno.writeTextFile("./nano-banana-response.log", responseLogMsg, {
            append: true
        });
    }
    //console.log("OpenRouter Response:", JSON.stringify(responseData, null, 2));
    if (responseData.error) return { type: 'text', content: responseData.error }; 
    if (responseData?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data) {
        let mimeType=responseData.candidates[0].content.parts[0].inlineData.mimeType;
        let prefix=`data:${mimeType};base64,`;
        let imgdata=prefix+responseData.candidates[0].content.parts[0].inlineData.data;
        return { type: 'image', content: imgdata };
    }
    return { type: 'text', content: "[模型没有返回有效内容]" };
    /*
    const message = responseData.choices?.[0]?.message;
    if (message?.images?.[0]?.image_url?.url) { return { type: 'image', content: message.images[0].image_url.url }; }
    if (typeof message?.content === 'string' && message.content.startsWith('data:image/')) { return { type: 'image', content: message.content }; }
    //add by sujialin
    if (typeof message?.content === 'string' && message.content.startsWith('![image]')) {
        const imageData = message.content.replace(/^!\[image\]\((.*?)\)$/, '$1');
        return { type: 'image', content: imageData };
    }
    if (typeof message?.content === 'string' && message.content.trim() !== '') { return { type: 'text', content: message.content }; }
    return { type: 'text', content: "[模型没有返回有效内容]" };
    */
}

// =======================================================
// 模块 2: ModelScope API 调用逻辑 (用于 Qwen-Image 等)
// =======================================================
// [修改] 函数接收一个 timeoutSeconds 参数
async function callModelScope(model: string, apikey: string, parameters: any, timeoutSeconds: number): Promise<{ imageUrl: string }> {
    const base_url = 'https://api-inference.modelscope.cn/';
    const common_headers = {
        "Authorization": `Bearer ${apikey}`,
        "Content-Type": "application/json",
    };
    console.log(`[ModelScope] Submitting task for model: ${model}`);
    const generationResponse = await fetch(`${base_url}v1/images/generations`, {
        method: "POST",
        headers: { ...common_headers, "X-ModelScope-Async-Mode": "true" },
        body: JSON.stringify({ model, ...parameters }),
    });
    if (!generationResponse.ok) {
        const errorBody = await generationResponse.text();
        throw new Error(`ModelScope API Error (Generation): ${generationResponse.status} - ${errorBody}`);
    }
    const { task_id } = await generationResponse.json();
    if (!task_id) { throw new Error("ModelScope API did not return a task_id."); }
    console.log(`[ModelScope] Task submitted. Task ID: ${task_id}`);
    
    // [修改] 动态计算最大轮询次数
    const pollingIntervalSeconds = 5;
    const maxRetries = Math.ceil(timeoutSeconds / pollingIntervalSeconds);
    console.log(`[ModelScope] Task timeout set to ${timeoutSeconds}s, polling a max of ${maxRetries} times.`);

    for (let i = 0; i < maxRetries; i++) {
        await sleep(pollingIntervalSeconds * 1000); // 使用变量
        console.log(`[ModelScope] Polling task status... Attempt ${i + 1}/${maxRetries}`);
        const statusResponse = await fetch(`${base_url}v1/tasks/${task_id}`, { headers: { ...common_headers, "X-ModelScope-Task-Type": "image_generation" } });
        if (!statusResponse.ok) {
            console.error(`[ModelScope] Failed to get task status. Status: ${statusResponse.status}`);
            continue;
        }
        const data = await statusResponse.json();
        if (data.task_status === "SUCCEED") {
            console.log("[ModelScope] Task Succeeded.");
            if (data.output?.images?.[0]?.url) {
                return { imageUrl: data.output.images[0].url };
            } else if (data.output_images?.[0]) {
                return { imageUrl: data.output_images[0] };
            } else {
                throw new Error("ModelScope task succeeded but returned no images.");
            }
        } else if (data.task_status === "FAILED") {
            console.error("[ModelScope] Task Failed.", data);
            throw new Error(`ModelScope task failed: ${data.message || 'Unknown error'}`);
        }
    }
    throw new Error(`ModelScope task timed out after ${timeoutSeconds} seconds.`);
}

function generateLogTimestamp(): string {
    const datenow = new Date();
    let logts=""+datenow.getFullYear()+"-";
    logts += (""+(datenow.getMonth()+1)).padStart(2, '0')+"-";
    logts += (""+(datenow.getDate())).padStart(2, '0')+" ";
    logts += (""+(datenow.getHours())).padStart(2, '0')+":";
    logts += (""+(datenow.getMinutes())).padStart(2, '0')+":";
    logts += (""+(datenow.getSeconds())).padStart(2, '0')+"  ";
    return logts;
}

async function isDevEnv() {
    const env = await load();
    const profile = env["profile"];
    return (profile && profile.trim().toLowerCase() === "dev");
}

async function fetchWithTimeout(resource: string, options: {}, timeout: number) {
        // 创建 AbortController 用于取消请求
    const controller = new AbortController();
    // 设置超时定时器，超时后取消请求
    const id = setTimeout(() => controller.abort(), timeout);
    // 发送请求，传入取消信号
    const response = await fetch(resource, { ...options, signal: controller.signal });
    // 清除定时器
    clearTimeout(id);
    return response;
}

// =======================================================
// 主服务逻辑
// =======================================================
serve(async (req) => {
    const pathname = new URL(req.url).pathname;
    
    if (req.method === 'OPTIONS') { 
        return new Response(null, { 
            status: 204, 
            headers: { 
                "Access-Control-Allow-Origin": "*", 
                "Access-Control-Allow-Methods": "POST, GET, OPTIONS", 
                "Access-Control-Allow-Headers": "Content-Type, Authorization" 
            } 
        }); 
    }

    if (pathname === "/api/key-status") {
        const isSet = !!Deno.env.get("OPENROUTER_API_KEY");
        return new Response(JSON.stringify({ isSet }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
    }

    if (pathname === "/api/modelscope-key-status") {
        const isSet = !!Deno.env.get("MODELSCOPE_API_KEY");
        return new Response(JSON.stringify({ isSet }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
    }

    if (pathname === "/generate") {
        try {
            // [修改] 从请求体中解构出 timeout
            const requestData = await req.json();
            const { model, apikey, prompt, images, parameters, timeout, imgWHRatio, imgSize } = requestData;

            if (model === 'nanobanana') {
                const openrouterApiKey = apikey || Deno.env.get("OPENROUTER_API_KEY");
                if (!openrouterApiKey) { return createJsonErrorResponse("OpenRouter API key is not set.", 500); }
                if (!prompt) { return createJsonErrorResponse("Prompt is required.", 400); }

                //拆分每行提示词句子
                let webUiMessages: any[] = [];
                let sentenses = prompt.split("\n");
                for (let i=0; i<sentenses.length; i++) {
                    sentenses[i] = sentenses[i].trim();
                    webUiMessages.push({
                        type: "prompt",
                        message: sentenses[i].trim()
                    });
                }
                
                if (images && Array.isArray(images) && images.length > 0) {
                    for (let i=0; i<images.length; i++) {
                        webUiMessages.push({
                            type: "image_url",
                            mimeType: images[i].mime_type,
                            message: images[i].data
                        });
                    }
                }
                /*
                const contentPayload: any[] = [{ type: "text", text: prompt }];
                if (images && Array.isArray(images) && images.length > 0) {
                    const imageParts = images.map(img => ({ type: "image_url", image_url: { url: img } }));
                    contentPayload.push(...imageParts);
                }
                const webUiMessages = [{ role: "user", content: contentPayload }];
                */
                const result = await callOpenRouter(requestData.modelName, webUiMessages, openrouterApiKey, imgWHRatio, imgSize);
                if (result.type === 'image') {
                    return new Response(JSON.stringify({ imageUrl: result.content }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
                } else {
                    return createJsonErrorResponse(`Model returned text instead of an image: "${result.content}"`, 400);
                }
            } else {
                const modelscopeApiKey = apikey || Deno.env.get("MODELSCOPE_API_KEY");
                if (!modelscopeApiKey) { return createJsonErrorResponse("ModelScope API key is not set.", 401); }
                if (!parameters?.prompt) { return createJsonErrorResponse("Positive prompt is required for ModelScope models.", 400); }
                
                // [修改] 将 timeout (或默认值) 传递给 callModelScope
                // Qwen 默认2分钟，其他默认3分钟
                const timeoutSeconds = timeout || (model.includes('Qwen') ? 120 : 180); 
                const result = await callModelScope(model, modelscopeApiKey, parameters, timeoutSeconds);

                return new Response(JSON.stringify(result), {
                    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
                });
            }
        } catch (error) {
            console.error("Error handling /generate request:", error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            return createJsonErrorResponse(errorMessage, 500);
        }
    }

    return serveDir(req, { fsRoot: "static", urlRoot: "", showDirListing: true, enableCors: true });
});
