import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rolePlan } from './admin-policy.mjs';
const args = {project:'test-project',uid:'firebase-uid',googleId:'123',role:'admin',user:{uid:'firebase-uid',disabled:false,providerData:[{providerId:'google.com',uid:'123'}]}};
test('admin bootstrap preserves Google namespace and defaults to dry run',()=>{
  assert.deepEqual(rolePlan(args),{project:'test-project',path:'roles/123',data:{role:'admin'},apply:false});
});
test('bootstrap rejects mismatched, disabled and unlinked Firebase accounts',()=>{
  for(const user of [{...args.user,uid:'other'},{...args.user,disabled:true},{...args.user,providerData:[]}]){
    assert.throws(()=>rolePlan({...args,user}));
  }
  assert.throws(()=>rolePlan({...args,googleId:'456'}));
  assert.throws(()=>rolePlan({...args,role:'owner'}));
});
