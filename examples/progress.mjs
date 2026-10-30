// A finite job that yields several times before completing. No dependencies.
let step = 0;
console.log("progress: started");
const timer = setInterval(() => {
  console.log(`progress: ${++step}/6`);
  if (step === 6) {
    clearInterval(timer);
    console.log("progress: done");
  }
}, 500);
