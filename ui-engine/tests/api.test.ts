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

describe('Scenario Seed Sanitizer (16 to 128 chars)',()=>{
  it('pads shorter numbers with trailing zeros to at least 16 characters', ()=>{
    expect(sanitizeNumericSeed('12345')).toBe('1234500000000000');
    expect(sanitizeNumericSeed('42')).toBe('4200000000000000');
  });

  it('preserves seeds between 16 and 128 characters and truncates beyond 128', ()=>{
    expect(sanitizeNumericSeed('12345678901234567890')).toBe('12345678901234567890');
    const long135 = '1'.repeat(135);
    expect(sanitizeNumericSeed(long135)).toBe('1'.repeat(128));
  });

  it('forces negative numbers to positive by stripping minus sign', ()=>{
    expect(sanitizeNumericSeed('-98765')).toBe('9876500000000000');
  });

  it('supports 128-char hex seeds starting with 0x', ()=>{
    expect(sanitizeNumericSeed('0x5089050192221083')).toBe('0x50890501922210830000000000000000');
  });

  it('preserves exactly 16 digit inputs', ()=>{
    expect(sanitizeNumericSeed('5089050192221083')).toBe('5089050192221083');
  });
});
