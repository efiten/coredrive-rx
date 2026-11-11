package eu.on8ar.coredriverx;

import android.content.Context;
import android.util.AttributeSet;
import android.view.View;
import com.getcapacitor.CapacitorWebView;

// The WebView that keeps running with the screen off. Android tells a WebView when its
// window stops being visible, and Chromium then treats the page as hidden: about a
// minute later JavaScript timers stop, and no upload, RF sample, region ask or uplink
// ping happened until the screen came back on (field logs of v1.24.3, 2026-11-11, three
// phones: 7 to 25 minutes without an upload while receptions kept arriving over
// Bluetooth). This view always reports its window as visible, so the page is never
// hidden. MainActivity tells the page about the real state with the appHidden and
// appVisible events.
public class AlwaysVisibleWebView extends CapacitorWebView {

    public AlwaysVisibleWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        super.onWindowVisibilityChanged(View.VISIBLE);
    }
}
