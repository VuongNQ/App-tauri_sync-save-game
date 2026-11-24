import { readFile } from 'node:fs/promises';
import { before, after, beforeEach, test } from 'node:test';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc, increment } from 'firebase/firestore';
import assert from 'node:assert/strict';

let env;
const A='111111111111111111111', B='222222222222222222222', ADMIN='999999999999999999999';
function db(id, uid=`firebase-${id}`) {
  return env.authenticatedContext(uid, {email:`${id}@example.com`,firebase:{sign_in_provider:'google.com',identities:{'google.com':[id]}}}).firestore();
}
const game={id:'game-a',name:'Test game',totalPlayTimeSeconds:10};
function profile(id,role='user'){return {userId:id,email:`${id}@example.com`,name:'Player',picture:null,role,registeredAt:'old-time',lastSeenAt:'now'};}
before(async()=>{
  const rules = await readFile(new URL('./firestore.rules',import.meta.url),'utf8');
  env=await initializeTestEnvironment({projectId:'demo-save-game-sync',firestore:{host:'127.0.0.1',port:8080,rules}});
  // initializeTestEnvironment only loads (default); load the same rules into the named database.
  const loaded = await fetch('http://127.0.0.1:8080/emulator/v1/projects/demo-save-game-sync/databases/savegame:securityRules',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({rules:{files:[{content:rules}]}})});
  assert.equal(loaded.status,200,await loaded.text());
});
after(async()=>{await env?.cleanup();});
beforeEach(async()=>{await env.clearFirestore();await env.withSecurityRulesDisabled(async c=>{
  const d=c.firestore();
  await setDoc(doc(d,`roles/${ADMIN}`),{role:'admin'});
  await setDoc(doc(d,`userProfiles/${A}`),profile(A));
  await setDoc(doc(d,`userProfiles/${B}`),profile(B));
  await setDoc(doc(d,`users/${A}/games/game-a`),game);
  await setDoc(doc(d,`users/${B}/games/game-a`),game);
});});

test('legacy Google paths remain accessible with a different Firebase UID',async()=>{
  await assertSucceeds(getDoc(doc(db(A,'new-firebase-uid'),`users/${A}/games/game-a`)));
  await assertSucceeds(updateDoc(doc(db(A),`users/${A}/games/game-a`),{totalPlayTimeSeconds:increment(5)}));
  await assertFails(getDoc(doc(db(A),`users/firebase-${A}/games/game-a`)));
});
test('A cannot read, modify or delete B data in any owner collection',async()=>{
  for(const path of [`users/${B}/games/game-a`,`users/${B}/settings/app`,`users/${B}/devices/pc`,`users/${B}/syncMeta/game-a`]){
    await assertFails(getDoc(doc(db(A),path)));
    await assertFails(setDoc(doc(db(A),path),game));
    await assertFails(deleteDoc(doc(db(A),path)));
  }
});
test('anonymous and unlinked identities cannot access user data',async()=>{
  const anonymous=env.unauthenticatedContext().firestore();
  const unlinked=env.authenticatedContext(A,{email:'attacker@example.com'}).firestore();
  await assertFails(getDoc(doc(anonymous,`users/${A}/games/game-a`)));
  await assertFails(getDoc(doc(unlinked,`users/${A}/games/game-a`)));
});
test('profile.role cannot self-promote and forged admin profiles do not authorize',async()=>{
  await assertFails(updateDoc(doc(db(A),`userProfiles/${A}`),{role:'admin'}));
  await env.withSecurityRulesDisabled(async c=>setDoc(doc(c.firestore(),`userProfiles/${A}`),profile(A,'admin')));
  await assertFails(setDoc(doc(db(A),'adminConfig/global'),{driveQuotaBytes:100}));
  await assertFails(getDocs(collection(db(A),'userProfiles')));
});
test('new first user cannot bootstrap admin or create their own role document',async()=>{
  const first='333333333333333333333';
  await assertFails(setDoc(doc(db(first),`roles/${first}`),{role:'admin'}));
  await assertFails(setDoc(doc(db(first),`userProfiles/${first}`),profile(first,'admin')));
  await assertSucceeds(setDoc(doc(db(first),`userProfiles/${first}`),profile(first)));
});
test('only protected admin can list users and grant another account a role',async()=>{
  await assertFails(setDoc(doc(db(A),`roles/${B}`),{role:'admin'}));
  await assertSucceeds(getDocs(collection(db(ADMIN),'userProfiles')));
  await assertSucceeds(setDoc(doc(db(ADMIN),`roles/${B}`),{role:'admin'}));
  await assertFails(setDoc(doc(db(ADMIN),`roles/${ADMIN}`),{role:'user'}));
  await assertFails(setDoc(doc(db(ADMIN),`roles/${A}`),{role:'admin',extra:'injected'}));
});
test('admin directory access does not grant access to other users game saves',async()=>{
  await assertFails(getDoc(doc(db(ADMIN),`users/${A}/games/game-a`)));
});
test('quota is readable by linked users and writable only by admin',async()=>{
  await assertSucceeds(setDoc(doc(db(ADMIN),'adminConfig/global'),{driveQuotaBytes:200*1024*1024}));
  await assertSucceeds(getDoc(doc(db(A),'adminConfig/global')));
  await assertFails(updateDoc(doc(db(A),'adminConfig/global'),{driveQuotaBytes:999}));
  await assertFails(updateDoc(doc(db(ADMIN),'adminConfig/global'),{driveQuotaBytes:-1}));
});
test('own profile can refresh without changing immutable identity or registration',async()=>{
  await assertSucceeds(updateDoc(doc(db(A),`userProfiles/${A}`),{lastSeenAt:'later',name:'New name'}));
  await assertFails(updateDoc(doc(db(A),`userProfiles/${A}`),{email:'other@example.com'}));
  await assertFails(updateDoc(doc(db(A),`userProfiles/${A}`),{registeredAt:'rewritten'}));
});
test('owner can save settings, device paths and metadata; hidden role paths stay denied',async()=>{
  await assertSucceeds(setDoc(doc(db(A),`users/${A}/settings/app`),{syncIntervalMinutes:5,startMinimised:false,runOnStartup:false}));
  await assertSucceeds(setDoc(doc(db(A),`users/${A}/devices/pc`),{pathOverrides:{'game-a':'D:/Saves'}}));
  await assertSucceeds(setDoc(doc(db(A),`users/${A}/syncMeta/game-a`),{json:'{}'}));
  await assertFails(setDoc(doc(db(A),`users/${A}/roles/admin`),{role:'admin'}));
  await assertFails(updateDoc(doc(db(A),`users/${A}/games/game-a`),{totalPlayTimeSeconds:-1}));
});

// Exercise the exact REST preconditions used by the Rust publisher. Emulator
// accepts unsigned test ID tokens; these never leave localhost or a demo project.
function restToken(id) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now()/1000);
  return `${encode({alg:'none',typ:'JWT'})}.${encode({sub:`firebase-${id}`,user_id:`firebase-${id}`,aud:'demo-save-game-sync',iss:'https://securetoken.google.com/demo-save-game-sync',iat:now,exp:now+3600,auth_time:now,email:`${id}@example.com`,firebase:{sign_in_provider:'google.com',identities:{'google.com':[id]}}})}.`;
}
async function restManifest(owner, identity, condition, value, database = '(default)') {
  const url = `http://127.0.0.1:8080/v1/projects/demo-save-game-sync/databases/${database}/documents:commit`;
  const name = `projects/demo-save-game-sync/databases/${database}/documents/users/${owner}/syncMeta/v2-test`;
  const response = await fetch(url, {method:'POST', headers:{Authorization:`Bearer ${restToken(identity)}`,'Content-Type':'application/json'}, body:JSON.stringify({writes:[{update:{name,fields:{data:{stringValue:value},gameId:{stringValue:'game-a'},protocol:{integerValue:'2'}}},currentDocument:condition}]})});
  const body = await response.json();
  return {status:response.status,body,updateTime:body.writeResults?.[0]?.updateTime};
}
test('REST first-sync race has exactly one create winner',async()=>{
  const results = await Promise.all([restManifest(A,A,{exists:false},'pc'),restManifest(A,A,{exists:false},'handheld')]);
  assert.equal(results.filter(r=>r.status===200).length,1,JSON.stringify(results));
  assert.equal(results.filter(r=>r.body.error?.status==='FAILED_PRECONDITION' || r.body.error?.status==='ALREADY_EXISTS').length,1);
});
test('REST stale updateTime cannot overwrite another device publication',async()=>{
  const initial = await restManifest(A,A,{exists:false},'baseline');
  assert.equal(initial.status,200);
  assert.equal(typeof initial.updateTime,'string');
  const condition = {updateTime:initial.updateTime};
  const results = await Promise.all([restManifest(A,A,condition,'pc-progress'),restManifest(A,A,condition,'handheld-progress')]);
  assert.equal(results.filter(r=>r.status===200).length,1,JSON.stringify(results));
  assert.equal(results.filter(r=>r.body.error?.status==='FAILED_PRECONDITION').length,1);
});
test('REST versioned manifests remain account-isolated',async()=>{
  assert.equal((await restManifest(B,A,{exists:false},'forged')).status,403);
});
test('REST named database enforces the same owner rules',async()=>{
  assert.equal((await restManifest(A,A,{exists:false},'named','savegame')).status,200);
  assert.equal((await restManifest(B,A,{exists:false},'forged','savegame')).status,403);
});
