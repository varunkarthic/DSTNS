// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Tutorial, placeTutorialCard } from "../src/Tutorial";
import { tutorialSteps } from "../src/tutorialSteps";
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('covers every telemetry view, measurements, notifications and error priority',()=>{
  for(const target of ['telemetry-roads','telemetry-vehicles','telemetry-incidents-metric','telemetry-weather','telemetry-congestion','telemetry-stack','telemetry-events','telemetry-queue','telemetry-incidents','telemetry-notifications','notifications','hud'])
    expect(tutorialSteps.some(s=>s.target===target),target).toBe(true);
  expect(tutorialSteps.find(s=>s.target==='telemetry-congestion')?.body).toContain('60%');
  expect(tutorialSteps.find(s=>s.target==='dnd')?.body).toContain('System errors always take priority');
});
it('supports back, keyboard navigation, skip, and target cleanup',()=>{
  const onSkip=vi.fn(), onStart=vi.fn(), onTarget=vi.fn();
  const {unmount}=render(<Tutorial onSkip={onSkip} onStart={onStart} onTarget={onTarget} reduceMotion/>);
  expect(screen.getByRole('button',{name:'Back'})).toBeDisabled();
  fireEvent.keyDown(document,{key:'ArrowRight'});
  expect(screen.getByRole('heading')).toHaveTextContent('Zoom and fit');
  fireEvent.click(screen.getByRole('button',{name:'Back'}));
  expect(screen.getByRole('heading')).toHaveTextContent('The live network');
  fireEvent.keyDown(document,{key:'Escape'});expect(onSkip).toHaveBeenCalledOnce();expect(onStart).not.toHaveBeenCalled();
  unmount();expect(onTarget).toHaveBeenLastCalledWith('');
});
it('places cards inside supported viewports beside a small target',()=>{
  for(const width of [1024,1280,1920]) for(const top of [20,300,540]) {
    const target={left:20,top,width:38,height:38};
    const p=placeTutorialCard(target,{width:340,height:240},{width,height:640});
    expect(p.left).toBeGreaterThanOrEqual(0);expect(p.top).toBeGreaterThanOrEqual(0);
    expect(p.left+340).toBeLessThanOrEqual(width);expect(p.top+240).toBeLessThanOrEqual(640);
  }
});
it('matches a circular target with a circular padded spotlight',()=>{
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this: HTMLElement){
    return {x:40,y:40,left:40,top:40,right:80,bottom:80,width:40,height:40,toJSON:()=>({})};
  });
  const {container}=render(<><button data-tutorial="map" style={{borderRadius:'50%',borderTopLeftRadius:'50%'}}>Map</button><Tutorial onSkip={vi.fn()} onStart={vi.fn()} onTarget={vi.fn()} reduceMotion/></>);
  expect(document.querySelector('.tour-spotlight')).toHaveStyle({width:'48px',height:'48px'});
  expect((document.querySelector('.tour-spotlight') as HTMLElement).style.borderRadius).toBe('24px');
  expect(container.querySelector('button')).toBeInTheDocument();
});
