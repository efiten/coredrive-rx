package eu.on8ar.coredriverx;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    // AlwaysVisibleWebView keeps document.hidden false, so the page hears from here
    // when the app really leaves the screen and when it is back.
    @Override
    public void onStop() {
        super.onStop();
        if (bridge != null) bridge.triggerDocumentJSEvent("appHidden");
    }

    @Override
    public void onStart() {
        super.onStart();
        if (bridge != null) bridge.triggerDocumentJSEvent("appVisible");
    }
}
