import {afterEach,describe,expect,it,vi} from 'vitest';
import {api} from '../src/api';
import {sanitizeNumericSeed} from '../src/App';

describe('DSTNS API client',()=>{
  afterEach(()=>vi.restoreAllMocks());
  it('uses the dedicated playback start endpoint',async()=>{
    const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({ok:true}),{status:202,headers:{'content-type':'application/json'}}));
    await api.start({seed:'0x1'});
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/playback/start',expect.objectContaining({method:'POST'}));
  });
  it('surfaces structured API messages',async()=>{
    vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({error:{message:'bad tick'}}),{status:400,headers:{'content-type':'application/json'}}));
    await expect(api.tick(0)).rejects.toThrow('bad tick');
  });
});

describe('16-Digit Numeric Seed Sanitizer',()=>{
  it('pads shorter numbers with trailing zeros to exactly 16 characters', ()=>{
    expect(sanitizeNumericSeed('12345')).toBe('1234500000000000');
    expect(sanitizeNumericSeed('42')).toBe('4200000000000000');
  });

  it('truncates longer inputs to the first 16 digits', ()=>{
    expect(sanitizeNumericSeed('1234567890123456789999')).toBe('1234567890123456');
  });

  it('forces negative numbers to positive by stripping minus sign', ()=>{
    expect(sanitizeNumericSeed('-98765')).toBe('9876500000000000');
  });

  it('ignores any non-digit characters in input', ()=>{
    expect(sanitizeNumericSeed('seed-0x45a9b2c!')).toBe('0459200000000000');
    expect(sanitizeNumericSeed('hello world')).toBe('0000000000000000');
  });

  it('preserves exactly 16 digit inputs', ()=>{
    expect(sanitizeNumericSeed('5089050192221083')).toBe('5089050192221083');
  });
});
