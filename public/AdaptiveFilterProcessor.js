class AdaptiveFilterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // LMS filter parameters
    this.filterLength = 128;
    this.mu = 0.01; // Step size
    this.weights = new Float32Array(this.filterLength);
    this.xBuffer = new Float32Array(this.filterLength);
    this.xIndex = 0;
  }

  process(inputs, outputs) {
    // inputs[0]: primary (mic), inputs[1]: reference (system)
    const inputMic = inputs[0][0];
    const inputSys = inputs[1][0];
    const output = outputs[0][0];
    if (!inputMic || !inputSys) {
      // Pass through if one input is missing
      for (let i = 0; i < output.length; i++) {
        output[i] = inputMic ? inputMic[i] : 0;
      }
      return true;
    }
    for (let i = 0; i < output.length; i++) {
      // Update reference buffer
      this.xBuffer[this.xIndex] = inputSys[i];
      // Compute filter output (dot product)
      let y = 0;
      for (let j = 0; j < this.filterLength; j++) {
        const idx = (this.xIndex - j + this.filterLength) % this.filterLength;
        y += this.weights[j] * this.xBuffer[idx];
      }
      // Error between mic and estimated echo
      const e = inputMic[i] - y;
      output[i] = e;
      // LMS update
      for (let j = 0; j < this.filterLength; j++) {
        const idx = (this.xIndex - j + this.filterLength) % this.filterLength;
        this.weights[j] += 2 * this.mu * e * this.xBuffer[idx];
      }
      this.xIndex = (this.xIndex + 1) % this.filterLength;
    }
    return true;
  }
}

registerProcessor("adaptive-filter-processor", AdaptiveFilterProcessor);
