import assert from "./assert";
import { ViewModelReflection } from "./def";
import { isUndefined, ArrayFilter, defineProperty, isNull, defineProperties, create, getOwnPropertyNames, forEach, hasOwnProperty, ArrayIndexOf, ArraySplice, ArrayPush, isFunction, isFalse } from "./language";
import { getCustomElementComponent } from "./component";
import { OwnerKey, isNodeOwnedByVM, VM } from "./vm";
import { register } from "./services";
import { pierce } from "./piercing";
import { Component } from "./component";
import { getCustomElementVM } from "./html-element";
import { Replicable } from "./membrane";

import { TargetSlot } from './membrane';
import {
    querySelector,
    querySelectorAll,
    GlobalAOMProperties,
    setAttribute,
    removeAttribute,
    DOCUMENT_POSITION_CONTAINED_BY,
    compareDocumentPosition,
    getRootNode,
    addEventListener,
    removeEventListener,
} from './dom';
import { getAttrNameFromPropName } from "./utils";
import { invokeRootCallback, isRendering, vmBeingRendered, isBeingConstructed } from "./invoker";

function getLinkedElement(root: ShadowRoot): HTMLElement {
    return getCustomElementVM(root).elm;
}

export interface ShadowRoot {
    [ViewModelReflection]: VM;
    readonly mode: string;
    readonly innerHTML: string;
    readonly host: Component;
    querySelector(selector: string): HTMLElement | null;
    querySelectorAll(selector: string): HTMLElement[];
    addEventListener(type: string, listener: EventListener, options: any): void;
    removeEventListener(type: string, listener: EventListener, options: any): void;
    toString(): string;
}

function createAccessibilityDescriptorForShadowRoot(propName: string, attrName: string, defaultValue: any): PropertyDescriptor {
    // we use value as the storage mechanism and as the default value for the property
    return {
        enumerable: false,
        get(this: ShadowRoot): any {
            const vm = getCustomElementVM(this);
            if (!hasOwnProperty.call(vm.rootProps, propName)) {
                return defaultValue;
            }
            return vm.rootProps[propName];
        },
        set(this: ShadowRoot, newValue: any) {
            const vm = getCustomElementVM(this);
            vm.rootProps[propName] = newValue;
            if (!isUndefined(vm.hostAttrs[attrName])) {
                return;
            }
            if (isNull(newValue)) {
                removeAttribute.call(vm.elm, attrName);
                return;
            }
            setAttribute.call(vm.elm, attrName, newValue);
        }
    };
}

const RootDescriptors: PropertyDescriptorMap = create(null);

// This routine will build a descriptor map for all AOM properties to be added
// to ShadowRoot prototype to polyfill AOM capabilities.
forEach.call(getOwnPropertyNames(GlobalAOMProperties), (propName: string) => RootDescriptors[propName] = createAccessibilityDescriptorForShadowRoot(propName, getAttrNameFromPropName(propName), GlobalAOMProperties[propName]));

export function shadowRootQuerySelector(shadowRoot: ShadowRoot, selector: string): Element | null {
    const vm = getCustomElementVM(shadowRoot);

    if (process.env.NODE_ENV !== 'production') {
        assert.isFalse(isBeingConstructed(vm), `this.root.querySelector() cannot be called during the construction of the custom element for ${vm} because no content has been rendered yet.`);
    }

    const elm = getLinkedElement(shadowRoot);
    return getFirstMatch(vm, elm, selector);
}

export function shadowRootQuerySelectorAll(shadowRoot: ShadowRoot, selector: string): HTMLElement[] {
    const vm = getCustomElementVM(shadowRoot);
    if (process.env.NODE_ENV !== 'production') {
        assert.isFalse(isBeingConstructed(vm), `this.root.querySelectorAll() cannot be called during the construction of the custom element for ${vm} because no content has been rendered yet.`);
    }
    const elm = getLinkedElement(shadowRoot);
    return getAllMatches(vm, elm, selector);
}

const eventListeners: WeakMap<EventListener, EventListener> = new WeakMap();

function getWrappedListener(listener: EventListener): EventListener {
    if (!isFunction(listener)) {
        return listener; // ignoring non-callable arguments
    }
    let wrappedListener = eventListeners.get(listener);
    if (isUndefined(wrappedListener)) {
        wrappedListener = function(event: Event) {
            const vm = getCustomElementVM(event.currentTarget as HTMLElement);
            if (process.env.NODE_ENV !== 'production') {
                assert.vm(vm);
            }
            // * if the event is dispatched directly on the host, it is not observable from root
            // * if the event is dispatched in an element that does not belongs to the shadow and it is not composed,
            //   it is not observable from the root
            if (event.target === event.currentTarget || (isFalse((event as any).composed) && getRootNode.call(event.target) !== event.currentTarget)) {
                return;
            }
            const e = pierce(event);
            invokeRootCallback(vm, listener, [e]);
        };
        eventListeners.set(listener, wrappedListener);
    }
    return wrappedListener;
}

export class Root implements ShadowRoot {
    [ViewModelReflection]: VM;
    constructor(vm: VM) {
        if (process.env.NODE_ENV !== 'production') {
            assert.vm(vm);
        }
        defineProperty(this, ViewModelReflection, {
            value: vm,
        });
    }
    get mode(): string {
        return 'closed';
    }
    get host(): Component {
        return getCustomElementVM(this).component as Component;
    }
    get innerHTML(): string {
        // TODO: should we add this only in dev mode? or wrap this in dev mode?
        throw new Error();
    }
    querySelector(selector: string): HTMLElement | null {
        const node = shadowRootQuerySelector(this as ShadowRoot, selector);
        if (process.env.NODE_ENV !== 'production') {
            const component = getCustomElementComponent(this as ShadowRoot);
            if (isNull(node) && component.querySelector(selector)) {
                assert.logWarning(`this.root.querySelector() can only return elements from the template declaration of ${component}. It seems that you are looking for elements that were passed via slots, in which case you should use this.querySelector() instead.`);
            }
        }
        return node as HTMLElement;
    }
    querySelectorAll(selector: string): HTMLElement[] {
        const nodeList = shadowRootQuerySelectorAll(this, selector);
        if (process.env.NODE_ENV !== 'production') {
            const component = getCustomElementComponent(this);
            if (nodeList.length === 0 && component.querySelectorAll(selector).length) {
                assert.logWarning(`this.root.querySelectorAll() can only return elements from template declaration of ${component}. It seems that you are looking for elements that were passed via slots, in which case you should use this.querySelectorAll() instead.`);
            }
        }
        return nodeList;
    }

    addEventListener(type: string, listener: EventListener, options: any) {
        const vm = getCustomElementVM(this);
        if (process.env.NODE_ENV !== 'production') {
            assert.vm(vm);
            assert.invariant(!isRendering, `${vmBeingRendered}.render() method has side effects on the state of ${vm} by adding an event listener for "${type}".`);
            assert.invariant(isFunction(listener), `Invalid second argument for this.root.addEventListener() in ${vm} for event "${type}". Expected an EventListener but received ${listener}.`);
            let { cmpEvents } = vm;
            if (isUndefined(cmpEvents)) {
                vm.cmpEvents = cmpEvents = create(null) as Record<string, EventListener[]>;
            }
            if (isUndefined(cmpEvents[type])) {
                cmpEvents[type] = [];
            }
            if (ArrayIndexOf.call(cmpEvents[type], listener) !== -1) {
                assert.logWarning(`${vm} has duplicate listeners for event "${type}". Instead add the event listener in the connectedCallback() hook.`);
            }
            ArrayPush.call(cmpEvents[type], listener);
        }
        addEventListener.call(vm.elm, type, getWrappedListener(listener), options);
    }

    removeEventListener(type: string, listener: EventListener, options: any) {
        const vm = getCustomElementVM(this);
        if (process.env.NODE_ENV !== 'production') {
            assert.vm(vm);
            assert.invariant(!isRendering, `${vmBeingRendered}.render() method has side effects on the state of ${vm} by removing an event listener for "${type}".`);
            assert.invariant(isFunction(listener), `Invalid second argument for this.root.removeEventListener() in ${vm} for event "${type}". Expected an EventListener but received ${listener}.`);
            let { cmpEvents } = vm;
            if (isUndefined(cmpEvents)) {
                vm.cmpEvents = cmpEvents = create(null) as Record<string, EventListener[]>;
            }
            if (isUndefined(cmpEvents[type])) {
                cmpEvents[type] = [];
            }
            if (isUndefined(cmpEvents) || isUndefined(cmpEvents[type]) || ArrayIndexOf.call(cmpEvents[type], listener) === -1) {
                assert.logError(`Did not find event listener ${listener} for event "${type}" on ${vm}. This is probably a typo or a life cycle mismatch. Make sure that you add the right event listeners in the connectedCallback() hook and remove them in the disconnectedCallback() hook.`);
            }
            ArraySplice.call(cmpEvents[type], ArrayIndexOf.call(cmpEvents[type], listener), 1);
        }
        removeEventListener.call(vm.elm, type, getWrappedListener(listener), options);
    }
    toString(): string {
        const component = getCustomElementComponent(this);
        return `Current ShadowRoot for ${component}`;
    }
}
defineProperties(Root.prototype, RootDescriptors);

function getFirstMatch(vm: VM, elm: Element, selector: string): Element | null {
    const nodeList = querySelectorAll.call(elm, selector);
    // search for all, and find the first node that is owned by the VM in question.
    for (let i = 0, len = nodeList.length; i < len; i += 1) {
        if (isNodeOwnedByVM(vm, nodeList[i])) {
            return pierce(nodeList[i]);
        }
    }
    return null;
}

function getAllMatches(vm: VM, elm: Element, selector: string): HTMLElement[] {
    const nodeList = querySelectorAll.call(elm, selector);
    const filteredNodes = ArrayFilter.call(nodeList, (node: Node): boolean => isNodeOwnedByVM(vm, node));
    return pierce(filteredNodes);
}

function getElementOwnerVM(elm: Element): VM | undefined {
    if (!(elm instanceof Node)) {
        return;
    }
    let node: Node | null = elm;
    let ownerKey;
    // search for the first element with owner identity (just in case of manually inserted elements)
    while (!isNull(node) && isUndefined((ownerKey = node[OwnerKey]))) {
        node = node.parentNode;
    }
    if (isUndefined(ownerKey) || isNull(node)) {
        return;
    }
    let vm: VM | undefined;
    // search for a custom element with a VM that owns the first element with owner identity attached to it
    while (!isNull(node) && (isUndefined(vm = node[ViewModelReflection]) || (vm as VM).uid !== ownerKey)) {
        node = node.parentNode;
    }
    return isNull(node) ? undefined : vm;
}

function isParentNodeKeyword(key: PropertyKey): boolean {
    return (key === 'parentNode' || key === 'parentElement');
}

function isIframeContentWindow(key: PropertyKey, value: any) {
    return (key === 'contentWindow') && value.window === value;
}

export function wrapIframeWindow(win: Window) {
    return {
        [TargetSlot]: win,
        postMessage() {
            return win.postMessage.apply(win, arguments);
        },
        blur() {
            return win.blur.apply(win, arguments);
        },
        close() {
            return win.close.apply(win, arguments);
        },
        focus() {
            return win.focus.apply(win, arguments);
        },
        get closed() {
            return win.closed;
        },
        get frames() {
            return win.frames;
        },
        get length() {
            return win.length;
        },
        get location() {
            return win.location;
        },
        set location(value) {
            (win.location as any) = value;
        },
        get opener() {
            return win.opener;
        },
        get parent() {
            return win.parent;
        },
        get self() {
            return win.self;
        },
        get top() {
            return win.top;
        },
        get window() {
            return win.window;
        },
    };
}

export function isChildNode(root: Element, node: Node): boolean {
    return !!(compareDocumentPosition.call(root, node) & DOCUMENT_POSITION_CONTAINED_BY);
}

// Registering a service to enforce the shadowDOM semantics via the Raptor membrane implementation
register({
    piercing(target: Replicable, key: PropertyKey, value: any, callback: (value?: any) => void) {
        if (value) {
            if (isIframeContentWindow(key as PropertyKey, value)) {
                callback(wrapIframeWindow(value));
            }
            if (value === querySelector) {
                return callback((selector: string): Node | null => {
                    const vm = getElementOwnerVM(target as Element);
                    return isUndefined(vm) ? null : getFirstMatch(vm, target as Element, selector);
                });
            }
            if (value === querySelectorAll) {
                return callback((selector: string): Element[] => {
                    const vm = getElementOwnerVM(target as Element);
                    return isUndefined(vm) ? [] : getAllMatches(vm, target as Element, selector);
                });
            }
            if (isParentNodeKeyword(key)) {
                const vm = getElementOwnerVM(target as Element);
                if (!isUndefined(vm) && value === vm.elm) {
                    // walking up via parent chain might end up in the shadow root element
                    return callback((vm.component as Component).root);
                } else if (target instanceof Element && value instanceof Element && target[OwnerKey] !== value[OwnerKey]) {
                    // cutting out access to something outside of the shadow of the current target (usually slots)
                    return callback(); // TODO: this should probably be `null`
                }
            }
            if (target instanceof Event) {
                switch (key) {
                    case 'currentTarget':
                        // intentionally return the host element pierced here otherwise the general role below
                        // will kick in and return the cmp, which is not the intent.
                        return callback(pierce(value));
                    case 'target':
                        const { currentTarget } = (target as Event);
                        const vm = currentTarget ? getElementOwnerVM(currentTarget as Element) : undefined;
                        if (!isUndefined(vm)) {
                            let node = value;
                            while (!isNull(node) && (vm as VM).uid !== node[OwnerKey]) {
                                node = node.parentNode;
                            }
                            return callback(pierce(node));
                        }
                }
            }
            if (value instanceof HTMLElement) {
                const vm = value[ViewModelReflection];
                if (!isUndefined(vm) && value === vm.elm) {
                    // prevent access to the original Host element
                    return callback(vm.component);
                }
            }
        }
    }
});
