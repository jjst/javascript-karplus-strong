function asmWrapper(channelBuffer, seedNoise, sampleRate, hz, smoothingFactor, velocity, options, string) {
    var targetArrayL = channelBuffer.getChannelData(0);
    var targetArrayR = channelBuffer.getChannelData(1);

    var heapFloat32Size = seedNoise.length + 
                          targetArrayL.length +
                          targetArrayR.length;
    var heapFloat32 = new Float32Array(heapFloat32Size);
    var i;
    for (i = 0; i < seedNoise.length; i++) {
        heapFloat32[i] = seedNoise[i];
    }

    // asm.js requires all data in/out of function to
    // be done through heap object
    // from the asm.js spec, it sounds like the heap must be
    // passed in as a plain ArrayBuffer
    // (.buffer is the ArrayBuffer referenced by the Float32Buffer)
    var heapBuffer = heapFloat32.buffer;
    var asm = asmFunctions(window, null, heapBuffer);

    var heapOffsets = {
        seedStart: 0,
        seedEnd: seedNoise.length - 1,
        targetStart: seedNoise.length,
        targetEnd: seedNoise.length + targetArrayL.length - 1
    };

    asm.renderKarplusStrong(heapOffsets,
                            sampleRate,
                            hz,
                            velocity,
                            smoothingFactor,
                            options.stringTension,
                            options.pluckDamping,
                            options.characterVariation);

    if (options.body == "simple") {
        asm.simpleBody(heapOffsets.targetStart, heapOffsets.targetEnd);
    }

    asm.fadeTails(heapOffsets.targetStart,
            heapOffsets.targetEnd - heapOffsets.targetStart + 1);
    
    /*
    asm.renderDecayedSine(heapOffsets,
                          sampleRate,
                          hz,
                          velocity);
    */

    // string.acousticLocation is set individually for each string such that
    // the lowest note has a value of -1 and the highest +1
    var stereoSpread = options.stereoSpread * string.acousticLocation;
    // for negative stereoSpreads, the note is pushed to the left
    // for positive stereoSpreads, the note is pushed to the right
    var gainL = (1 - stereoSpread) * 0.5;
    var gainR = (1 + stereoSpread) * 0.5;
    for (i = 0; i < targetArrayL.length; i++) {
        targetArrayL[i] = heapFloat32[heapOffsets.targetStart+i] * gainL;
    }
    for (i = 0; i < targetArrayL.length; i++) {
        targetArrayR[i] = heapFloat32[heapOffsets.targetStart+i] * gainR;
    }
}

// standard asm.js block
// stdlib: object through which standard library functions are called
// foreign: object through which external javascript functions are called
// heap: buffer used for all data in/out of function
function asmFunctions(stdlib, foreign, heapBuffer) {
    "use asm";

    // heap is supposed to come in as just an ArrayBuffer
    // so first need to get a Float32 view of it
    var heap = new stdlib.Float32Array(heapBuffer);
    var fround = stdlib.Math.fround;
    var sin = stdlib.Math.sin;
    var pi = stdlib.Math.PI;
    var floor = stdlib.Math.floor;

    function lowPass(lastOutput, currentInput, smoothingFactor) {

        // coersion to indicate type of arguments
        // fround indicates type float
        lastOutput = fround(lastOutput);
        currentInput = fround(currentInput);
        smoothingFactor = fround(smoothingFactor);

        var currentOutput = fround(0);
        currentOutput = fround(
            fround(smoothingFactor * currentInput) +
            fround(fround(fround(1.0) - smoothingFactor) * lastOutput)
        );

        return fround(currentOutput);
    }

    // this is copied verbatim from the original ActionScript source
    // haven't figured out how it works yet
    // we do all the arithmetic using doubles rather than floats,
    // because in the asm.js spec, operations done floats resolve
    // to 'floatish'es, which need to be coerced back into floats,
    // and the code becomes unreadable
    function simpleBody(heapStart, heapEnd) {
        // '|0' declares parameter as int
        // http://asmjs.org/spec/latest/#parameter-type-annotations
        heapStart = heapStart|0;
        heapEnd = heapEnd|0;

        // explicitly initialise all variables so types are declared
        var r00 = 0.0;
        var f00 = 0.0;
        var r10 = 0.0;
        var f10 = 0.0;
        var f0 = 0.0;
        var c0 = 0.0;
        var c1 = 0.0;
        var r0 = 0.0;
        var r1 = 0.0;
        var curInput = 0.0;
        var lastInput = 0.0;
        var lastOutput = 0.0;
        var i = 0;
        
        // +x indicates that x is a double
        // (asm.js Math functions take doubles as arguments)
        c0 = 2.0 * sin(pi * 3.4375 / 44100.0);
        c1 = 2.0 * sin(pi * 6.124928687214833 / 44100.0);
        r0 = 0.98;
        r1 = 0.98;

        // asm.js seems to require byte addressing of the heap...?
        // http://asmjs.org/spec/latest/#validateheapaccess-e
        // yeah, when accessing the heap with an index which is an expression,
        // the total index expression is validated in a way that
        // forces the index to be a byte
        // and apparently '|0' coerces to signed when not in the context
        // of parameters
        // http://asmjs.org/spec/latest/#binary-operators
        for (i = heapStart << 2; (i|0) < (heapEnd << 2); i = (i + 4)|0) {
            r00 = r00 * r0;
            r00 = r00 + (f0 - f00) * c0;
            f00 = f00 + r00;
            f00 = f00 - f00 * f00 * f00 * 0.166666666666666;
            r10 = r10 * r1;
            r10 = r10 + (f0 - f10) * c1;
            f10 = f10 + r10;
            f10 = f10 - f10 * f10 * f10 * 0.166666666666666;
            f0 = +heap[i >> 2];
            heap[i >> 2] = fround(
                    f0 + (f00 + f10) * 2.0
            );

            curInput = +heap[i >> 2];
            heap[i >> 2] = fround(
                    0.99 * lastOutput + 0.99*(curInput - lastInput)
            );
            lastInput = curInput;
            lastOutput = +heap[i >> 2];
        }
    }
    
    // apply a fade envelope to the end of a buffer
    // to make it end at zero ampltiude
    // (to avoid clicks heard when sample otherwise suddenly
    //  cuts off)
    function fadeTails(heapStart, length) {
        heapStart = heapStart|0;
        length = length|0;

        var heapEnd = 0;
        var tailProportion = 0.0;
        var tailSamples = 0;
        var tailSamplesStart = 0;
        var i = 0;
        var samplesThroughTail = 0;
        var proportionThroughTail = 0.0;
        var gain = 0.0;

        tailProportion = 0.1;
        // we first convert length from an int to an unsigned (>>>0)
        // so that we can convert it a double for the argument of floor()
        // then convert it to a double (+)
        // then convert the double result of floor to a signed with ~~
        // http://asmjs.org/spec/latest/#binary-operators
        // http://asmjs.org/spec/latest/#standard-library
        // http://asmjs.org/spec/latest/#binary-operators
        tailSamples = ~~floor(+(length>>>0) * tailProportion);
        // http://asmjs.org/spec/latest/#additiveexpression
        // the result of an additive addition is an intish,
        // which must be coerced back to an int
        tailSamplesStart = (heapStart + length - tailSamples)|0;

        heapEnd = (heapStart + length)|0;

        // so remember, i represents a byte index,
        // and the heap is a Float32Array (4 bytes)
        for (i = tailSamplesStart << 2, samplesThroughTail = 0;
                (i|0) < (heapEnd << 2);
                i = (i + 4)|0,
                samplesThroughTail = (samplesThroughTail+1)|0) {
            proportionThroughTail =
                    (+(samplesThroughTail>>>0)) / (+(tailSamples>>>0));
            gain = 1.0 - proportionThroughTail;
            heap[i >> 2] = heap[i >> 2] * fround(gain);
        }
    }

    // the "smoothing factor" parameter is the coefficient
    // used on the terms in the low-pass filter
    function renderKarplusStrong(heapOffsets,
                                 sampleRate, hz, velocity,
                                 smoothingFactor, stringTension,
                                 pluckDamping,
                                 characterVariation
                                ) {
        // coersion to indicate type of arguments
        // ORing with 0 indicates type int
        var seedNoiseStart = heapOffsets.seedStart|0;
        var seedNoiseEnd = heapOffsets.seedEnd|0;
        var targetArrayStart = heapOffsets.targetStart|0;
        var targetArrayEnd = heapOffsets.targetEnd|0;
        sampleRate = sampleRate|0;
        hz = hz|0;

        // Math.fround(x) indicates type float
        var hz_float = Math.fround(hz);
        var period = Math.fround(1/hz_float);
        var periodSamples_float = Math.fround(period*sampleRate);
        // int
        var periodSamples = Math.round(periodSamples_float)|0;
        var frameCount = (targetArrayEnd-targetArrayStart+1)|0;
        var targetIndex = 0;
        var lastOutputSample = 0;
        var curInputSample = 0;

        for (targetIndex = 0;
                targetIndex < frameCount;
                targetIndex++) {
            var heapTargetIndex = (targetArrayStart + targetIndex)|0;
            if (targetIndex < periodSamples) {
                // for the first period, feed in noise
                var heapNoiseIndex = (seedNoiseStart + targetIndex)|0;
                var noiseSample = Math.fround(heap[heapNoiseIndex]);
                // create room for character variation noise
                noiseSample *= (1 - characterVariation);
                // add character variation
                noiseSample += characterVariation * (-1 + 2*Math.random());
                curInputSample = lowPass(curInputSample, noiseSample, pluckDamping);
            } else {
                // for subsequent periods, feed in the output from
                // about one period ago
                var lastPeriodIndex = heapTargetIndex - periodSamples;
                var skipFromTension = Math.round(stringTension * periodSamples);
                var inputIndex = lastPeriodIndex + skipFromTension;
                curInputSample = Math.fround(heap[inputIndex]);
            }

            // output is low-pass filtered version of input
            var curOutputSample = lowPass(lastOutputSample, curInputSample, smoothingFactor);
            heap[heapTargetIndex] = curOutputSample;
            lastOutputSample = curOutputSample;
        }
    }

    function renderDecayedSine(heapOffsets,
                               sampleRate, hz, velocity) {
        // coersion to indicate type of arguments
        var seedNoiseStart = heapOffsets.noiseStart|0;
        var seedNoiseEnd = heapOffsets.noiseEnd|0;
        var targetArrayStart = heapOffsets.targetStart|0;
        var targetArrayEnd = heapOffsets.targetEnd|0;
        sampleRate = sampleRate|0;
        hz = hz|0;
        velocity = +velocity;
        // use Math.fround(x) to specify x's type to be 'float'
        var hz_float = Math.fround(hz);
        var unity = Math.fround(1);
        var period = Math.fround(unity/hz_float);
        var periodSamples_float = Math.fround(period*sampleRate);
        // int
        var periodSamples = Math.round(periodSamples_float)|0;
        var frameCount = (targetArrayEnd-targetArrayStart+1)|0;

        var targetIndex = 0;
        while(1) {
            var heapTargetIndex = (targetArrayStart + targetIndex)|0;
            var t = Math.fround(Math.fround(targetIndex)/Math.fround(sampleRate));
            heap[heapTargetIndex] = 
                velocity *
                Math.pow(2, -Math.fround(targetIndex) / (Math.fround(frameCount)/8)) *
                Math.sin(2 * Math.PI * hz * t);
            targetIndex = (targetIndex + 1)|0;
            if (targetIndex == frameCount) {
                break;
            }
        }
    }

    return {
        renderKarplusStrong: renderKarplusStrong,
        renderDecayedSine: renderDecayedSine,
        fadeTails: fadeTails,
        simpleBody: simpleBody,
    };
}

