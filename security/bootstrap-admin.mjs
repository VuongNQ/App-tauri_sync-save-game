// Trusted workstation tool. Dry-run unless --apply is supplied. Uses ADC; never
// put a service-account key in the desktop app or in this repository.
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { parseArgs } from 'node:util';
import { rolePlan } from './admin-policy.mjs';

const { values } = parseArgs({ options: {
  project: { type:'string' }, uid: { type:'string' }, 'google-id': { type:'string' },
  role: { type:'string' }, database: { type:'string', default:'(default)' }, apply: { type:'boolean', default:false },
} });
if (!values.project || !values.uid || !values['google-id'] || !values.role) {
  throw new Error('Usage: node bootstrap-admin.mjs --project PROJECT [--database DATABASE_ID] --uid FIREBASE_UID --google-id GOOGLE_ID --role admin|user [--apply]');
}
const app = initializeApp({ credential:applicationDefault(), projectId:values.project });
const user = await getAuth(app).getUser(values.uid);
const plan = rolePlan({ project:values.project, uid:values.uid, googleId:values['google-id'], role:values.role, user, apply:values.apply });
console.log(JSON.stringify({ ...plan, database: values.database },null,2));
if (plan.apply) {
  await getFirestore(app, values.database).doc(plan.path).set(plan.data);
  console.log('Protected role updated. Reconnect or refresh the desktop app to read it.');
} else {
  console.log('Dry run only. No role was changed.');
}
