import * as assert from 'assert';

// import * as vscode from 'vscode';
import * as util from '../../util';
import { getVSCodeDownloadUrl } from 'vscode-test/out/util';

suite('Util Test Suite', () => {
    //vscode.window.showInformationMessage('Start Util unit tests');

    test('debounce test', async () => {
        let fCalls: Array<[Date, number]> = [];
        let f = util.debounce((i: number) => {
            fCalls.push([new Date(), i]);
            console.log(`f(${i}) called`);
        }, 10);

        f(1);
        f(2);
        f(3);
        await util.sleep(50);
        assert.equal(fCalls.length, 1, "f called != 1 times!");
        assert.equal(fCalls[0][1], 3, "f(3) wasn't called");
    });

    test('throttle test', async () => {
        let fCalls: Array<[Date, number]> = [];
        let f = util.throttle((i: number) => {
            fCalls.push([new Date(), i]);
            console.log(`f(${i}) called`);
        }, 10);

        f(1);
        f(2);
        f(3);
        f(4);
        await util.sleep(100);
        fCalls.forEach(value => {
            console.log(`throttled f(${value[1]}) called at ${value[0].getTime()}`);
        });
        assert.equal(fCalls.length, 2, "f called != 2 times!"); // the first and the last
        assert.equal(fCalls[0][1], 1, "f(1) wasn't called");
        assert.equal(fCalls[1][1], 4, "f(4) wasn't called");

    });

});
