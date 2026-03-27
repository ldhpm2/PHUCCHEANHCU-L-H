import { GoogleGenAI } from "@google/genai";

// ==========================================
// CONFIGURATION
// ==========================================
// Updated prompt with user's specific instructions
const PROMPT = "Restore this old photo to high quality. Sharpen details, remove scratches, noise and blur. Colorize with vivid and realistic colors. Creatively enhance and restore details in clothes and hair. Ensure the final image is highly detailed and photorealistic.";

const state = {
    file: null as File | null,
    imgBase64: null as string | null,
    processedBase64: null as string | null,
    isProcessed: false,
    isDragging: false
};

// ==========================================
// DOM ELEMENTS
// ==========================================
const els = {
    uploadSection: document.getElementById('upload-section')!,
    editorSection: document.getElementById('editor-section')!,
    dropZone: document.getElementById('drop-zone')!,
    fileInput: document.getElementById('file-input') as HTMLInputElement,
    imgBefore: document.getElementById('img-before') as HTMLImageElement,
    imgAfter: document.getElementById('img-after') as HTMLImageElement,
    afterWrapper: document.getElementById('after-wrapper')!,
    compareContainer: document.getElementById('compare-container')!,
    sliderHandle: document.getElementById('slider-handle')!,
    processOverlay: document.getElementById('process-overlay')!,
    statusBadge: document.getElementById('status-badge')!,
    btnDownload: document.getElementById('btn-download') as HTMLButtonElement,
    btnProcess: document.getElementById('btn-process') as HTMLButtonElement,
    btnReset: document.getElementById('btn-reset') as HTMLButtonElement,
    btnCloseError: document.getElementById('btn-close-error')!,
    errorToast: document.getElementById('error-toast')!,
    errorMessage: document.getElementById('error-message')!
};

// ==========================================
// UPLOAD LOGIC
// ==========================================
els.fileInput.addEventListener('change', handleFileSelect);

// Drag & Drop visual feedback
els.dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.dropZone.classList.add('border-blue-500', 'bg-blue-50');
});

els.dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    els.dropZone.classList.remove('border-blue-500', 'bg-blue-50');
});

els.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    els.dropZone.classList.remove('border-blue-500', 'bg-blue-50');
    if (e.dataTransfer && e.dataTransfer.files.length) {
        els.fileInput.files = e.dataTransfer.files;
        // @ts-ignore
        handleFileSelect({ target: els.fileInput });
    }
});

function handleFileSelect(e: any) {
    const file = e.target.files[0];
    if (!file) return;

    // Validate
    if (!file.type.match('image.*')) {
        showError('Vui lòng chọn file ảnh (JPG, PNG, WEBP)');
        return;
    }
    if (file.size > 10 * 1024 * 1024) { // 10MB limit for API
        showError('File quá lớn. Vui lòng chọn ảnh dưới 10MB');
        return;
    }

    state.file = file;
    const reader = new FileReader();
    reader.onload = (ev) => {
        state.imgBase64 = ev.target?.result as string;
        initEditor(state.imgBase64);
    };
    reader.readAsDataURL(file);
}

function initEditor(src: string) {
    els.imgBefore.src = src;
    els.imgAfter.src = src; // Initially same for layout
    
    els.uploadSection.classList.add('hidden');
    els.editorSection.classList.remove('hidden');
    
    // Reset states
    state.isProcessed = false;
    els.afterWrapper.classList.add('hidden');
    els.sliderHandle.classList.add('hidden');
    els.processOverlay.classList.remove('opacity-0', 'pointer-events-none');
    els.btnDownload.disabled = true;
    els.btnDownload.classList.remove('bg-black', 'text-white', 'hover:bg-gray-800', 'shadow-lg');
    els.btnDownload.classList.add('bg-gray-100', 'text-gray-400');
    
    // Sync widths on load
    els.imgBefore.onload = () => {
        syncDimensions();
    }
}

// ==========================================
// PROCESSING LOGIC WITH GEMINI
// ==========================================
els.btnProcess.addEventListener('click', processImage);

function getClosestAspectRatio(width: number, height: number) {
  const ratio = width / height;
  const ratios = {
    "1:1": 1,
    "3:4": 3/4,
    "4:3": 4/3,
    "9:16": 9/16,
    "16:9": 16/9
  };
  
  let closestKey = "1:1";
  let closestVal = 1;
  let minDiff = Infinity;
  
  for (const [key, val] of Object.entries(ratios)) {
    const diff = Math.abs(ratio - val);
    if (diff < minDiff) {
      minDiff = diff;
      closestKey = key;
      closestVal = val;
    }
  }
  return { key: closestKey, val: closestVal };
}

// Pads the image to match the target aspect ratio exactly (adding black bars)
// This ensures that when the AI generates an image with the strict supported aspect ratio,
// it aligns perfectly with this padded input.
async function padImage(base64: string, targetRatio: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const currentRatio = img.width / img.height;
            let targetWidth = img.width;
            let targetHeight = img.height;

            if (currentRatio > targetRatio) {
                // Image is wider than target: Pad height (Top/Bottom bars)
                targetHeight = img.width / targetRatio;
            } else {
                // Image is taller than target: Pad width (Left/Right bars)
                targetWidth = img.height * targetRatio;
            }

            const canvas = document.createElement('canvas');
            canvas.width = targetWidth;
            canvas.height = targetHeight;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                reject("Canvas context not supported");
                return;
            }
            
            // Fill with black to act as letterboxing
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, targetWidth, targetHeight);
            
            // Draw image centered
            const x = (targetWidth - img.width) / 2;
            const y = (targetHeight - img.height) / 2;
            ctx.drawImage(img, x, y);
            
            resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = reject;
        img.src = base64;
    });
}

async function processImage() {
    if (!state.imgBase64 || !state.file) return;

    // UI Loading
    els.processOverlay.classList.add('opacity-0', 'pointer-events-none');
    els.statusBadge.classList.remove('hidden');
    
    try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        
        // 1. Calculate best supported ratio
        const { key: ratioKey, val: ratioVal } = getClosestAspectRatio(els.imgBefore.naturalWidth, els.imgBefore.naturalHeight);

        // 2. Pad the input image to match this ratio perfectly
        // This solves the issue where AI output (fixed ratio) doesn't align with User Input (arbitrary ratio)
        const paddedBase64 = await padImage(state.imgBase64, ratioVal);
        const base64Data = paddedBase64.split(',')[1];

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: {
                parts: [
                    {
                        inlineData: {
                            data: base64Data,
                            mimeType: 'image/png' // Canvas result is png
                        }
                    },
                    {
                        text: PROMPT
                    }
                ]
            },
            config: {
                imageConfig: {
                    aspectRatio: ratioKey as any
                }
            }
        });

        let foundImage = false;
        if (response.candidates && response.candidates[0].content && response.candidates[0].content.parts) {
            for (const part of response.candidates[0].content.parts) {
                if (part.inlineData && part.inlineData.data) {
                    const mimeType = part.inlineData.mimeType || 'image/png';
                    state.processedBase64 = `data:${mimeType};base64,${part.inlineData.data}`;
                    
                    // Update UI:
                    // Set Before image to the Padded version so it aligns with After image
                    els.imgBefore.src = paddedBase64;
                    els.imgAfter.src = state.processedBase64;
                    
                    foundImage = true;
                    break;
                }
            }
        }

        if (!foundImage) {
            throw new Error("No image generated by AI.");
        }

        finishProcessing();

    } catch (error) {
        console.error(error);
        showError('Không thể xử lý ảnh. Vui lòng thử lại hoặc chọn ảnh khác.');
        els.processOverlay.classList.remove('opacity-0', 'pointer-events-none');
    } finally {
        els.statusBadge.classList.add('hidden');
    }
}

function finishProcessing() {
    state.isProcessed = true;
    
    // Show Slider UI
    els.afterWrapper.classList.remove('hidden');
    els.sliderHandle.classList.remove('hidden');
    
    // Enable Download
    els.btnDownload.disabled = false;
    els.btnDownload.classList.remove('bg-gray-100', 'text-gray-400', 'cursor-not-allowed');
    els.btnDownload.classList.add('bg-black', 'text-white', 'hover:bg-gray-800', 'shadow-lg');

    // Wait for new image to load to sync layout
    els.imgAfter.onload = () => {
        syncDimensions();
        setSliderPosition(50);
    };
}

// ==========================================
// SLIDER LOGIC
// ==========================================
function setSliderPosition(percentage: number) {
    percentage = Math.max(0, Math.min(100, percentage));
    
    els.afterWrapper.style.width = `${percentage}%`;
    els.sliderHandle.style.left = `${percentage}%`;
}

function syncDimensions() {
    // Ensure the inner 'After' image always matches the container width
    if(els.compareContainer.offsetWidth > 0) {
        els.imgAfter.style.width = `${els.compareContainer.offsetWidth}px`;
    }
}

const startDrag = () => state.isDragging = true;
const stopDrag = () => state.isDragging = false;

const moveDrag = (e: any) => {
    if (!state.isDragging) return;
    
    const rect = els.compareContainer.getBoundingClientRect();
    let clientX = e.clientX;
    if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
    }
    
    let x = clientX - rect.left;
    let percent = (x / rect.width) * 100;
    
    setSliderPosition(percent);
};

els.compareContainer.addEventListener('mousedown', startDrag);
els.compareContainer.addEventListener('touchstart', startDrag);

window.addEventListener('mouseup', stopDrag);
window.addEventListener('touchend', stopDrag);

window.addEventListener('mousemove', moveDrag);
window.addEventListener('touchmove', moveDrag);

window.addEventListener('resize', syncDimensions);

// ==========================================
// UTILITIES
// ==========================================
els.btnReset.addEventListener('click', resetApp);
els.btnDownload.addEventListener('click', downloadImage);
els.btnCloseError.addEventListener('click', hideError);

function resetApp() {
    state.file = null;
    state.imgBase64 = null;
    state.processedBase64 = null;
    els.fileInput.value = '';
    
    els.editorSection.classList.add('hidden');
    els.uploadSection.classList.remove('hidden');
}

function downloadImage() {
    if (!state.processedBase64) return;
    
    const a = document.createElement('a');
    a.href = state.processedBase64; 
    a.download = `NPVRestore_${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

function showError(msg: string) {
    els.errorMessage.textContent = msg;
    els.errorToast.classList.remove('hidden');
    setTimeout(hideError, 4000);
}

function hideError() {
    els.errorToast.classList.add('hidden');
}
