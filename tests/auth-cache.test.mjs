import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/react-query';
import { applyAuthStatus } from '../src/queries/authCache.ts';

test('switching accounts clears library, devices, admin and per-game caches',async()=>{
  const q=new QueryClient();
  q.setQueryData(['auth-status'],{authenticated:true,userId:'A',role:'admin'});
  for(const key of [['dashboard'],['devices'],['settings'],['admin-users'],['drive-files','game'],['game-sync-result','game']]) q.setQueryData(key,{private:'A'});
  await applyAuthStatus(q,{authenticated:true,userId:'B',role:'user'});
  assert.equal(q.getQueryData(['dashboard']),undefined);
  assert.equal(q.getQueryData(['devices']),undefined);
  assert.equal(q.getQueryCache().getAll().length,1);
  assert.equal(q.getQueryData(['auth-status']).userId,'B');
  q.clear();
});
test('late query completion cannot repopulate an old-account cache after signout',async()=>{
  const q=new QueryClient({defaultOptions:{queries:{retry:false}}});
  q.setQueryData(['auth-status'],{authenticated:true,userId:'A',role:'user'});
  let finish;
  const pending=q.fetchQuery({queryKey:['dashboard'],queryFn:()=>new Promise(resolve=>{finish=resolve})}).catch(()=>undefined);
  await applyAuthStatus(q,{authenticated:false,userId:null,role:'user'});
  finish({private:'A'}); await pending;
  assert.equal(q.getQueryData(['dashboard']),undefined);
  assert.equal(q.getQueryData(['auth-status']).authenticated,false);
  q.clear();
});
test('role refresh for the same account preserves its library cache',async()=>{
  const q=new QueryClient();
  q.setQueryData(['auth-status'],{authenticated:true,userId:'A',role:'user'});
  q.setQueryData(['dashboard'],{owner:'A'});
  await applyAuthStatus(q,{authenticated:true,userId:'A',role:'admin'});
  assert.deepEqual(q.getQueryData(['dashboard']),{owner:'A'}); q.clear();
});
