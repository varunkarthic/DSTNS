// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NotificationCapsule } from "../src/notifications/NotificationCapsule";
import type { UiNotification } from "../src/core/notificationModel";
afterEach(cleanup);
const event: UiNotification={id:'rain',type:'rain',category:'weather',severity:'alert',title:'Heavy rain',summary:'Rain over the district',timestamp:60,startedAt:60,newsIds:[1],details:[],technical:[],count:1};
it('preempts an expanded event with a system error, and removes it on recovery',()=>{
  const props={items:[event],focusedKey:null,reduceMotion:true,onDismiss:vi.fn()};
  const {rerender}=render(<NotificationCapsule {...props}/>);
  fireEvent.click(screen.getByRole('button',{name:/Expand notification/}));
  rerender(<NotificationCapsule {...props} systemError="Simulator unavailable"/>);
  expect(screen.getByRole('alert')).toHaveTextContent('Simulator unavailable');
  expect(screen.getByRole('button',{name:/Collapse notification/})).toHaveTextContent('System error');
  rerender(<NotificationCapsule {...props}/>);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('button',{name:/Collapse notification/})).toHaveTextContent('Heavy rain');
});
it('shows runtime failures even when DND leaves no visible events',()=>{
  render(<NotificationCapsule items={[]} focusedKey={null} reduceMotion onDismiss={vi.fn()} systemError="Connection failed"/>);
  expect(screen.getByRole('alert')).toHaveTextContent('Connection failed');
  expect(screen.queryByLabelText('Dismiss notification')).toBeNull();
});
it('retains a stable notification anchor when no event is present',()=>{
  const {container}=render(<NotificationCapsule items={[]} focusedKey={null} reduceMotion onDismiss={vi.fn()}/>);
  expect(container.querySelector('[data-tutorial="notifications"]')).toBeInTheDocument();
  expect(screen.getByText('No new events')).toBeInTheDocument();
});
it('keeps a lone system error expanded until recovery',()=>{
  const props={items:[],focusedKey:null,reduceMotion:true,onDismiss:vi.fn()};
  const {rerender}=render(<NotificationCapsule {...props} systemError="Connection failed"/>);
  fireEvent.click(screen.getByRole('button',{name:/Expand notification/}));
  expect(screen.getByRole('button',{name:/Collapse notification/})).toBeInTheDocument();
  rerender(<NotificationCapsule {...props}/>);
  expect(screen.queryByRole('alert')).toBeNull();
});
it('keeps what is being read still: new events wait behind a count, and the full text is there',()=>{
  const long={...event,title:'A very long title that a collapsed capsule would have to cut off',summary:'The whole of a long summary, every word of it, available once opened.',technical:[{label:'Cell',value:'7'}]};
  const later={...event,id:'later',title:'Something newer',summary:'Newer'};
  const props={focusedKey:null,reduceMotion:true,onDismiss:vi.fn()};
  const {rerender,container}=render(<NotificationCapsule {...props} items={[long]}/>);
  fireEvent.click(screen.getByRole('button',{name:/Expand notification/}));
  expect(container.querySelector('.capsule-full-title')).toHaveTextContent(long.title);
  expect(container.querySelector('.capsule-summary')).toHaveTextContent(long.summary);
  fireEvent.click(screen.getByRole('button',{name:/Technical details/}));
  expect(screen.getByText('Cell')).toBeInTheDocument();
  rerender(<NotificationCapsule {...props} items={[later,long]}/>);
  // The same event, the same details open, and the newcomer not in the list.
  expect(container.querySelector('.capsule-full-title')).toHaveTextContent(long.title);
  expect(screen.getByText('Cell')).toBeInTheDocument();
  expect(screen.queryByText('Something newer')).toBeNull();
  const waiting=screen.getByRole('button',{name:'1 new event'});
  fireEvent.click(waiting);
  expect(container.querySelector('.capsule-full-title')).toHaveTextContent(long.title);
  expect(screen.getByText('Something newer')).toBeInTheDocument();
});

