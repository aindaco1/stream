import { checkLiveStripe } from '../src/stripe-live-operations.js';

try {
  const readiness = await checkLiveStripe(process.env);
  console.log(JSON.stringify(readiness,null,2));
  if (!readiness.activeTaxLocations.includes('US-NM') ||
      Object.values(readiness).some(value => value === false || value === null)) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
